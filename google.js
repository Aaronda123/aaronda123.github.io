// ==============================================================================================================
// google.js – Google Kalender und Gmail direkt aus dem Browser, ohne eigenen Server.
// Anmeldung: Google Identity Services (GIS) Token-Client, geladen erst bei Bedarf von accounts.google.com/gsi/client.
// Die OAuth-Client-ID trägt jeder selbst in den Einstellungen ein (settings.googleClientId) – im öffentlichen Code steht
// keine. Zugriffs-Token (≤ 1 h) liegen nur im Speicher und in sessionStorage (store.SESSION_KEYS.googleToken), nie in
// localStorage; dauerhaft gespeichert wird nur, WAS er erlaubt hat (store.googleLink: calendar, mail, email).
// Rechte schrittweise: zuerst Kalender (calendar.events + calendar.readonly), Gmail (readonly, compose, send) erst,
// wenn er zum ersten Mal nach Mails fragt. Abgelaufen → still mit prompt:"" neu anfragen; blockiert der Browser das
// Fenster (kein Tippen), meldet google.js "needsTap" und Jarvis zeigt „Google verbinden“ zum Antippen.
// Schreiben (Termin eintragen, Entwurf speichern, Mail senden) ruft nur app.js nach seinem ausdrücklichen „ja“ auf.
// export const SCOPES; class GoogleError { code: "notConfigured"|"loading"|"needsTap"|"denied"|"closed"|"scope"|
//                                          "apiOff"|"network"|"http"|"timeout"|"aborted"|"noRecipient"|"notFound" }
// export function init({ clientId?, onChange }); configured(); status(); preload({ force }?); connect({ mail }) (im Tippen!)
// export function disconnect(); forget(); can(op)   op: "calRead"|"calWrite"|"mailRead"|"mailDraft"|"mailSend"
// export async function events({ from, to, max, signal, quiet }); refreshEvents({ quiet, signal }); cachedEvents()
// export async function createEvent({ title, start, end, allDay, location }, { signal })
// export async function unread({ max, signal }); findMail({ from, index, signal }); readMail(id, { signal })
// export function lastMail(); lastList(); rememberMail(mail)
// export async function saveDraft(m, { signal }); sendMail(m, { signal })   m: { to, subject, body, threadId,
//                                                                            inReplyTo, references, draftId }
// pure (unit-tested): buildRaw(m), plainText(payload), parseAddress(header), mapEvent(item, cal), localIso(date)
// Imports store.js only. No top-level DOM access (node-safe for the unit checks).
// ==============================================================================================================
import * as store from "./store.js";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const CAL = "https://www.googleapis.com/calendar/v3";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
export const SCOPES = Object.freeze({
  calendar: Object.freeze(["https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly"]),
  mail: Object.freeze(["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send"]),
});
const NEED = Object.freeze({
  calRead: [SCOPES.calendar[0], SCOPES.calendar[1]],          // eins von beiden reicht zum Lesen
  calWrite: [SCOPES.calendar[0]],
  mailRead: [SCOPES.mail[0]],
  mailDraft: [SCOPES.mail[1]],
  mailSend: [SCOPES.mail[2], SCOPES.mail[1]],                // send oder compose
});
const ANY_OF = new Set(["calRead", "mailSend"]);
const FETCH_MS = 12000;
const SILENT_MS = 15000;          // stilles Erneuern: so lange darf das Google-Fenster brauchen
const INTERACTIVE_MS = 180000;    // Anmeldung mit Zustimmung
const CAL_LIST_MS = 10 * 60000;
const MAX_CALENDARS = 10;
const MAIL_TEXT_MAX = 6000;

export class GoogleError extends Error {
  constructor(code, message = "", status = 0) {
    super(message || code);
    this.name = "GoogleError";
    this.code = code;
    this.status = status;
  }
}

let deps = { clientId: () => store.settings().googleClientId, onChange: null };
let gisPromise = null;
let client = null;
let clientFor = "";
let token = null;                 // { access, exp, scopes: string[], cid }
let waiting = null;               // laufende Token-Anfrage { resolve, reject, timer }
let renewing = null;              // stilles Erneuern, auf das parallele Aufrufe gemeinsam warten
let needsTap = false;
let lastError = "";
let eventsCache = { at: 0, list: [], ok: false };
let calCache = { at: 0, items: [] };
let mails = [];                   // zuletzt gelistete Mails (Kopfzeilen)
let mailNow = null;               // zuletzt gelesene Mail (mit Text)

// ---------------------------------------------------------------- kleine Helfer
const pad2 = (n) => String(n).padStart(2, "0");
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const now = () => Date.now();

function clientIdNow() {
  try { return String(deps.clientId?.() ?? "").trim(); } catch { return ""; }
}

function emit() {
  try { deps.onChange?.(status()); } catch { /* ignore */ }
}

function hasGis() {
  try { return !!globalThis.google?.accounts?.oauth2?.initTokenClient; } catch { return false; }
}

function session() {
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

function saveToken() {
  const ss = session();
  if (!ss) return;
  try {
    if (token) ss.setItem(store.SESSION_KEYS.googleToken, JSON.stringify(token));
    else ss.removeItem(store.SESSION_KEYS.googleToken);
  } catch { /* ignore */ }
}

function loadToken() {
  const ss = session();
  if (!ss) return;
  try {
    const t = JSON.parse(ss.getItem(store.SESSION_KEYS.googleToken) || "null");
    if (isObj(t) && typeof t.access === "string" && Number(t.exp) > now() + 30000 && t.cid === clientIdNow()) {
      token = { access: t.access, exp: Number(t.exp), scopes: Array.isArray(t.scopes) ? t.scopes.map(String) : [], cid: t.cid };
    }
  } catch { /* ignore */ }
}

function dropToken() {
  token = null;
  saveToken();
}

function valid() {
  return !!token && token.exp > now() + 20000 && token.cid === clientIdNow();
}

/** Darf Jarvis das gerade (gültiges Token mit dem nötigen Recht)? */
export function can(op) {
  if (!valid()) return false;
  const need = NEED[op] || [];
  return ANY_OF.has(op) ? need.some((s) => token.scopes.includes(s)) : need.every((s) => token.scopes.includes(s));
}

function kindOf(op) {
  return String(op).startsWith("cal") ? "calendar" : "mail";
}

// ---------------------------------------------------------------- öffentliche Grundfunktionen

/**
 * @param {{ clientId?: () => string, onChange?: (status) => void }} d  clientId: default settings().googleClientId
 */
export function init(d = {}) {
  deps = { ...deps, ...(d || {}) };
  loadToken();
  if (configured()) preload();                               // vor dem ersten Tippen auf „Verbinden“ schon da
}

/** Eine Client-ID ist eingetragen (Format geprüft). */
export function configured() {
  return store.GOOGLE_CLIENT_RX.test(clientIdNow());
}

export function status() {
  const link = store.googleLink();
  return {
    configured: configured(),
    loaded: hasGis(),
    connected: valid(),
    calendar: can("calRead"),
    calendarWrite: can("calWrite"),
    mail: can("mailRead"),
    linked: link,
    email: link.email || "",
    expiresAt: valid() ? token.exp : 0,
    needsTap: needsTap && configured(),
    error: lastError,
  };
}

/** GIS-Skript laden (einmal); ohne Client-ID nur mit force (er tippt sie gerade ein). @returns {Promise<boolean>} */
export function preload({ force = false } = {}) {
  if ((!force && !configured()) || typeof document === "undefined") return Promise.resolve(false);
  if (hasGis()) return Promise.resolve(true);
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.dataset.jarvis = "gis";
    s.onload = () => {
      const ok = hasGis();
      if (!ok) { gisPromise = null; s.remove(); lastError = "load"; }
      resolve(ok);
      emit();
    };
    s.onerror = () => {
      gisPromise = null;
      s.remove();
      lastError = "load";
      resolve(false);
      emit();
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

function tokenClient() {
  const id = clientIdNow();
  if (!hasGis() || !store.GOOGLE_CLIENT_RX.test(id)) return null;
  if (client && clientFor === id) return client;
  client = globalThis.google.accounts.oauth2.initTokenClient({
    client_id: id,
    scope: SCOPES.calendar.join(" "),
    include_granted_scopes: true,
    callback: onToken,
    error_callback: onTokenError,
  });
  clientFor = id;
  return client;
}

function settle(fn, value) {
  const w = waiting;
  waiting = null;
  if (!w) return;
  clearTimeout(w.timer);
  try { w[fn](value); } catch { /* ignore */ }
}

function onToken(resp) {
  if (!resp || resp.error || !resp.access_token) {
    const code = resp?.error === "access_denied" ? "denied" : "http";
    lastError = code;
    emit();
    settle("reject", new GoogleError(code, String(resp?.error_description || resp?.error || "")));
    return;
  }
  const granted = String(resp.scope || "").split(/\s+/).filter(Boolean);
  const keep = valid() ? token.scopes : [];
  token = { access: String(resp.access_token), exp: now() + (Number(resp.expires_in) || 3600) * 1000,
    scopes: [...new Set([...keep, ...granted])], cid: clientIdNow() };
  saveToken();
  needsTap = false;
  lastError = "";
  const link = store.googleLink();
  store.setGoogleLink({ calendar: link.calendar || can("calRead"), mail: link.mail || can("mailRead") });
  emit();
  settle("resolve", token);
}

function onTokenError(err) {
  const type = String(err?.type || err?.message || "");
  const code = /popup_failed|blocked/i.test(type) ? "needsTap" : /popup_closed|closed/i.test(type) ? "closed" : "http";
  if (code !== "closed") lastError = code;
  emit();
  settle("reject", new GoogleError(code, type));
}

/** Token anfragen; im Tippen aufrufen, wenn Google ein Fenster zeigen muss (synchron bis requestAccessToken). */
function request(kinds, prompt) {
  const c = tokenClient();
  if (!c) return Promise.reject(new GoogleError(hasGis() ? "notConfigured" : "loading"));
  if (waiting) settle("reject", new GoogleError("closed", "superseded"));
  return new Promise((resolve, reject) => {
    const scope = [...new Set(kinds.flatMap((k) => SCOPES[k] || []))].join(" ");
    const timer = setTimeout(() => settle("reject", new GoogleError("timeout")), prompt === "" ? SILENT_MS : INTERACTIVE_MS);
    waiting = { resolve, reject, timer };
    try {
      c.requestAccessToken({ scope, prompt, include_granted_scopes: true });
    } catch (e) {
      settle("reject", new GoogleError("needsTap", String(e?.message || e)));
    }
  });
}

/**
 * „Verbinden“: MUSS synchron in einem Tippen laufen (Google öffnet ein Fenster). mail = Gmail gleich mit erlauben.
 * @returns {Promise<{ ok: boolean, code?: string }>}
 */
export function connect({ mail = false } = {}) {
  if (!configured()) return Promise.resolve({ ok: false, code: "notConfigured" });
  if (!hasGis()) {
    preload();
    return Promise.resolve({ ok: false, code: "loading" });
  }
  const link = store.googleLink();
  const kinds = mail || link.mail ? ["calendar", "mail"] : ["calendar"];
  return request(kinds, "").then(() => {
    calCache = { at: 0, items: [] };
    calendars({}).catch(() => []);                       // E-Mail-Adresse des Kontos (Hauptkalender) nachladen
    return { ok: true };
  }, (e) => ({ ok: false, code: e?.code || "http" }));
}

/** „Trennen“: Token bei Google zurückziehen, alles Gemerkte zu Google vergessen (Client-ID bleibt). */
export function disconnect() {
  const access = token?.access;
  forget();
  store.setGoogleLink(null);
  if (access && hasGis()) {
    try { globalThis.google.accounts.oauth2.revoke(access, () => {}); } catch { /* ignore */ }
  }
  emit();
}

/** Speicher leeren (auch für „Alles löschen“). */
export function forget() {
  if (waiting) settle("reject", new GoogleError("closed", "forget"));
  dropToken();
  needsTap = false;
  lastError = "";
  eventsCache = { at: 0, list: [], ok: false };
  calCache = { at: 0, items: [] };
  mails = [];
  mailNow = null;
}

/**
 * Gültiges Token für op – sonst still erneuern (nur, wenn er diesen Teil schon einmal erlaubt hat). quiet: gar kein
 * Google-Fenster versuchen (Hintergrund-Aktualisierung der Termine).
 */
async function ensure(op, { quiet = false } = {}) {
  if (!configured()) throw new GoogleError("notConfigured");
  if (can(op)) return token.access;
  const kind = kindOf(op);
  const linked = store.googleLink()[kind];
  if (quiet || !linked) {
    if (!quiet) { needsTap = true; emit(); }
    const e = new GoogleError("needsTap", linked ? "expired" : "first");
    e.first = !linked;                                       // noch nie erlaubt: nur ein Tippen kann Google fragen
    e.kind = kind;
    throw e;
  }
  if (!hasGis()) {
    await preload();
    if (!hasGis()) throw new GoogleError("network", "gis");
  }
  const kinds = kind === "mail" || store.googleLink().mail ? ["calendar", "mail"] : ["calendar"];
  try {
    // mehrere Kalender werden parallel gelesen: nur EIN Google-Fenster, alle warten auf dasselbe Token
    if (!renewing) renewing = request(kinds, "").finally(() => { renewing = null; });
    await renewing;
  } catch (e) {
    if (e?.code !== "denied") { needsTap = true; emit(); }
    throw e?.code === "denied" ? e : new GoogleError("needsTap", String(e?.code || ""));
  }
  if (!can(op)) throw new GoogleError("scope");
  return token.access;
}

function combine(signal, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  const off = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", off, { once: true });
  }
  return { signal: ctl.signal, done: () => { clearTimeout(t); signal?.removeEventListener?.("abort", off); } };
}

async function api(op, url, { method = "GET", body, signal, quiet = false, retry = true } = {}) {
  const access = await ensure(op, { quiet });
  const c = combine(signal, FETCH_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${access}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: c.signal,
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch (e) {
    if (signal?.aborted) throw new GoogleError("aborted");
    throw new GoogleError(c.signal.aborted ? "timeout" : "network", String(e?.message || e));
  } finally {
    c.done();
  }
  if (res.status === 401) {                                  // abgelaufen oder zurückgezogen: einmal neu holen
    if (token && token.access === access) dropToken();       // ein inzwischen neues Token (paralleler Aufruf) bleibt
    if (retry && !quiet) return api(op, url, { method, body, signal, quiet, retry: false });
    needsTap = !quiet || needsTap;
    emit();
    throw new GoogleError("needsTap", "401", 401);
  }
  if (!res.ok) {
    let j = null;
    try { j = await res.json(); } catch { j = null; }
    const reason = String(j?.error?.errors?.[0]?.reason || j?.error?.status || "");
    const msg = String(j?.error?.message || "");
    if (res.status === 403 && /insufficient|scope/i.test(`${reason} ${msg}`)) throw new GoogleError("scope", msg, 403);
    if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used|disabled/i.test(`${reason} ${msg}`)) {
      throw new GoogleError("apiOff", msg, 403);
    }
    if (res.status === 404) throw new GoogleError("notFound", msg, 404);
    throw new GoogleError("http", msg || `HTTP ${res.status}`, res.status);
  }
  if (res.status === 204) return null;
  try { return await res.json(); } catch { return null; }
}

// ---------------------------------------------------------------- Kalender

/** Ortszeit ohne Zone: „2026-10-17T15:00:00“. */
export function localIso(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
}

function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dateOnly(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** Google-Termin → { id, title, start, end, allDay, location, calendar }; abgesagt/abgelehnt → null. */
export function mapEvent(e, cal = {}) {
  if (!isObj(e) || e.status === "cancelled") return null;
  if (Array.isArray(e.attendees) && e.attendees.some((a) => a && a.self && a.responseStatus === "declined")) return null;
  const allDay = !!(e.start && e.start.date && !e.start.dateTime);
  const start = allDay ? dateOnly(e.start.date) : new Date(e.start?.dateTime || "");
  if (!start || Number.isNaN(start.getTime())) return null;
  let end = allDay ? dateOnly(e.end?.date) : new Date(e.end?.dateTime || "");
  if (!end || Number.isNaN(end.getTime())) end = new Date(start.getTime() + (allDay ? 86400000 : 3600000));
  return { id: String(e.id || ""), title: String(e.summary || "").trim().slice(0, 120) || "(ohne Titel)", start, end, allDay,
    location: String(e.location || "").trim().slice(0, 120), calendar: String(cal.name || "") };
}

async function calendars({ signal, quiet = false } = {}) {
  if (calCache.items.length && now() - calCache.at < CAL_LIST_MS) return calCache.items;
  let items = [];
  try {
    const j = await api("calRead", `${CAL}/users/me/calendarList?minAccessRole=reader&maxResults=50`, { signal, quiet });
    items = (Array.isArray(j?.items) ? j.items : [])
      .filter((c) => c && !c.hidden && !c.deleted && c.selected !== false)
      .map((c) => ({ id: String(c.id || ""), name: String(c.summaryOverride || c.summary || ""), primary: !!c.primary }))
      .filter((c) => c.id)
      .sort((a, b) => Number(b.primary) - Number(a.primary))
      .slice(0, MAX_CALENDARS);
    const main = items.find((c) => c.primary);
    if (main && /@/.test(main.id) && store.googleLink().email !== main.id) {
      store.setGoogleLink({ email: main.id });
      emit();
    }
  } catch (e) {
    if (e?.code !== "scope") throw e;                        // nur calendar.events erlaubt: Hauptkalender reicht
  }
  if (!items.length) items = [{ id: "primary", name: "", primary: true }];
  calCache = { at: now(), items };
  return items;
}

/**
 * Termine aller sichtbaren Kalender zwischen from und to, sortiert.
 * @returns {Promise<object[]>}
 */
export async function events({ from, to, max = 50, signal, quiet = false } = {}) {
  const a = from instanceof Date ? from : new Date();
  const b = to instanceof Date ? to : new Date(a.getTime() + 14 * 86400000);
  const cals = await calendars({ signal, quiet });
  const qs = (c) => `${CAL}/calendars/${encodeURIComponent(c.id)}/events?` + new URLSearchParams({
    timeMin: a.toISOString(), timeMax: b.toISOString(), singleEvents: "true", orderBy: "startTime",
    maxResults: String(Math.max(1, Math.min(250, max))),
  }).toString();
  const lists = await Promise.all(cals.map((c) => api("calRead", qs(c), { signal, quiet })
    .then((j) => (Array.isArray(j?.items) ? j.items : []).map((e) => mapEvent(e, c)).filter(Boolean))
    .catch((e) => { if (c.primary || cals.length === 1) throw e; return []; })));
  const seen = new Set();
  return lists.flat()
    .filter((e) => {
      const k = `${e.title}|${e.start.getTime()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((x, y) => x.start - y.start)
    .slice(0, max);
}

/** Termine von heute 0 Uhr bis in 14 Tagen in den Zwischenspeicher (Panel TERMINE, Kontext fürs Gehirn). */
export async function refreshEvents({ quiet = true, signal } = {}) {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const list = await events({ from, to: new Date(from.getTime() + 14 * 86400000), max: 60, signal, quiet });
  eventsCache = { at: now(), list, ok: true };
  emit();
  return list;
}

/** @returns {{ at: number, list: object[], ok: boolean }} */
export function cachedEvents() {
  return { at: eventsCache.at, list: eventsCache.list.slice(), ok: eventsCache.ok };
}

/**
 * Termin im Hauptkalender anlegen (nur nach seinem „ja“, app.js).
 * @param {{ title: string, start: Date, end?: Date, allDay?: boolean, location?: string }} ev
 */
export async function createEvent(ev, { signal } = {}) {
  const start = ev?.start instanceof Date ? ev.start : new Date(ev?.start);
  if (!ev || Number.isNaN(start.getTime())) throw new GoogleError("http", "start");
  const allDay = !!ev.allDay;
  let end = ev.end instanceof Date ? ev.end : ev.end ? new Date(ev.end) : null;
  if (!end || Number.isNaN(end.getTime()) || end <= start) end = new Date(start.getTime() + (allDay ? 86400000 : 3600000));
  let tz = "Europe/Berlin";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch { /* default */ }
  const body = { summary: String(ev.title || "Termin").slice(0, 200) };
  if (ev.location) body.location = String(ev.location).slice(0, 200);
  if (allDay) {
    const e2 = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    body.start = { date: ymd(start) };
    body.end = { date: ymd(end > e2 ? end : e2) };
  } else {
    body.start = { dateTime: localIso(start), timeZone: tz };
    body.end = { dateTime: localIso(end), timeZone: tz };
  }
  const j = await api("calWrite", `${CAL}/calendars/primary/events`, { method: "POST", body, signal });
  eventsCache = { ...eventsCache, at: 0 };
  return mapEvent(j || { ...body, id: "", start: body.start, end: body.end }, { name: "" });
}

// ---------------------------------------------------------------- Gmail

/** „"Anna Beispiel" <anna@example.org>“ → { name, email }. */
export function parseAddress(h) {
  const s = String(h || "").trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) {
    const email = m[2].trim();
    return { name: m[1].trim() || email.split("@")[0], email };
  }
  return { name: s.split("@")[0] || s, email: /@/.test(s) ? s : "" };
}

function header(payload, name) {
  const list = Array.isArray(payload?.headers) ? payload.headers : [];
  const h = list.find((x) => String(x?.name || "").toLowerCase() === name.toLowerCase());
  return h ? String(h.value || "") : "";
}

function b64urlBytes(data) {
  const b = String(data || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4 ? "=".repeat(4 - (b.length % 4)) : "";
  const bin = atob(b + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeBody(data) {
  try { return new TextDecoder("utf-8").decode(b64urlBytes(data)); } catch { return ""; }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", auml: "ä", ouml: "ö", uuml: "ü",
  Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", euro: "€" };

function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (all, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : all;
      }
      return ENTITIES[e] ?? all;
    });
}

function tidy(text) {
  let t = String(text || "").replace(/\r/g, "");
  // zitierte Antworten weg: ab „Am … schrieb …:“ / „On … wrote:“ und Zeilen mit „>“
  const cut = t.search(/^(?:Am .{4,120} schrieb .{1,120}:|On .{4,120} wrote:|-{2,} ?Original(?:nachricht| Message) ?-{2,})\s*$/m);
  if (cut > 0) t = t.slice(0, cut);
  t = t.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
  return t.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAIL_TEXT_MAX);
}

/** Lesbarer Text einer Gmail-Nachricht (payload aus format=full): text/plain zuerst, sonst HTML ohne Tags. */
export function plainText(payload) {
  const parts = [];
  const walk = (p, depth = 0) => {
    if (!p || depth > 8) return;
    if (p.body && p.body.data) parts.push({ type: String(p.mimeType || "").toLowerCase(), data: p.body.data });
    for (const c of Array.isArray(p.parts) ? p.parts : []) walk(c, depth + 1);
  };
  walk(payload);
  const plain = parts.find((x) => x.type === "text/plain");
  if (plain) return tidy(decodeBody(plain.data));
  const html = parts.find((x) => x.type === "text/html");
  if (html) return tidy(htmlToText(decodeBody(html.data)));
  return "";
}

function metaOf(j) {
  const p = j?.payload || {};
  const from = parseAddress(header(p, "From"));
  const date = Number(j?.internalDate) ? new Date(Number(j.internalDate)) : new Date(header(p, "Date") || Date.now());
  return { id: String(j?.id || ""), threadId: String(j?.threadId || ""), from: from.name, fromEmail: from.email,
    subject: header(p, "Subject").trim().slice(0, 200) || "(ohne Betreff)", date,
    snippet: htmlToText(String(j?.snippet || "")).replace(/\s+/g, " ").trim().slice(0, 240),
    unread: Array.isArray(j?.labelIds) ? j.labelIds.includes("UNREAD") : true };
}

async function getMeta(id, signal) {
  const q = new URLSearchParams({ format: "metadata" });
  for (const h of ["From", "Subject", "Date"]) q.append("metadataHeaders", h);
  return metaOf(await api("mailRead", `${GMAIL}/messages/${encodeURIComponent(id)}?${q}`, { signal }));
}

/** Ungelesene Mails der letzten zwei Tage (Kopfzeilen, neueste zuerst). */
export async function unread({ max = 8, signal } = {}) {
  const q = new URLSearchParams({ q: "is:unread newer_than:2d", maxResults: String(Math.max(1, Math.min(20, max))) });
  const j = await api("mailRead", `${GMAIL}/messages?${q}`, { signal });
  const ids = (Array.isArray(j?.messages) ? j.messages : []).map((m) => String(m?.id || "")).filter(Boolean);
  const list = (await Promise.all(ids.map((id) => getMeta(id, signal).catch(() => null)))).filter(Boolean);
  list.sort((a, b) => b.date - a.date);
  mails = list;
  return list.slice();
}

function normName(s) {
  return String(s || "").toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}@. ]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Mail finden: index (1 = neueste der Liste) oder Absender (Name oder Adresse). @returns {Promise<object|null>} */
export async function findMail({ from = "", index = 0, signal } = {}) {
  if (!mails.length) await unread({ signal });
  if (index > 0) return mails[index - 1] || null;
  const who = normName(from);
  if (!who) return mails[0] || null;
  const hit = mails.find((m) => normName(m.from).includes(who) || normName(m.fromEmail).includes(who)
    || who.split(" ").every((w) => normName(m.from).includes(w)));
  if (hit) return hit;
  const q = new URLSearchParams({ q: `from:(${String(from).replace(/[()"]/g, " ").trim()}) newer_than:30d`, maxResults: "1" });
  const j = await api("mailRead", `${GMAIL}/messages?${q}`, { signal });
  const id = String(j?.messages?.[0]?.id || "");
  return id ? getMeta(id, signal) : null;
}

/** Eine Mail ganz lesen (Text ohne zitierte Antworten). */
export async function readMail(id, { signal } = {}) {
  const j = await api("mailRead", `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, { signal });
  const p = j?.payload || {};
  const m = { ...metaOf(j), to: header(p, "To"), replyTo: parseAddress(header(p, "Reply-To")).email,
    messageId: header(p, "Message-ID") || header(p, "Message-Id"), references: header(p, "References"),
    text: plainText(p) || String(j?.snippet || "") };
  mailNow = m;
  return { ...m };
}

/** @returns {object|null} die zuletzt gelesene Mail */
export function lastMail() {
  return mailNow ? { ...mailNow } : null;
}

/** @returns {object[]} die zuletzt gelistete Mails */
export function lastList() {
  return mails.slice();
}

function utf8B64(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function encHeader(s) {
  const t = String(s || "").replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${utf8B64(t)}?=`;
}

function cleanAddr(s) {
  return String(s || "").replace(/[\r\n<>",;]+/g, " ").trim();
}

/**
 * RFC-2822-Nachricht (text/plain, UTF-8, base64) als base64url für Gmail „raw“.
 * @param {{ to: string, subject?: string, body?: string, inReplyTo?: string, references?: string }} m
 */
export function buildRaw(m) {
  const to = cleanAddr(m?.to);
  const lines = [`To: ${to}`, `Subject: ${encHeader(m?.subject || "")}`, "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=\"UTF-8\"", "Content-Transfer-Encoding: base64"];
  const irt = String(m?.inReplyTo || "").replace(/[\r\n]+/g, " ").trim();
  if (irt) {
    lines.push(`In-Reply-To: ${irt}`);
    lines.push(`References: ${[String(m?.references || "").replace(/[\r\n]+/g, " ").trim(), irt].filter(Boolean).join(" ")}`);
  }
  const body = utf8B64(String(m?.body || "").replace(/\r?\n/g, "\r\n")).replace(/.{76}(?=.)/g, "$&\r\n");
  return utf8B64(`${lines.join("\r\n")}\r\n\r\n${body}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mailBody(m) {
  const body = { message: { raw: buildRaw(m) } };
  if (m?.threadId) body.message.threadId = String(m.threadId);
  return body;
}

/** Entwurf in Gmail speichern (nur nach seinem „ja“ bzw. Tippen). @returns {Promise<{ id: string }>} */
export async function saveDraft(m, { signal } = {}) {
  const j = await api("mailDraft", `${GMAIL}/drafts`, { method: "POST", body: mailBody(m), signal });
  return { id: String(j?.id || ""), messageId: String(j?.message?.id || "") };
}

/** Mail senden (nur nach seinem ausdrücklichen „ja“ bzw. Tippen auf „Senden“). @returns {Promise<{ id: string }>} */
export async function sendMail(m, { signal } = {}) {
  if (m?.draftId) {
    const j = await api("mailSend", `${GMAIL}/drafts/send`, { method: "POST", body: { id: String(m.draftId) }, signal });
    return { id: String(j?.id || "") };
  }
  const j = await api("mailSend", `${GMAIL}/messages/send`, { method: "POST", body: mailBody(m).message, signal });
  return { id: String(j?.id || "") };
}

/** Für Tests und „lies sie vor“: eine Mail als zuletzt gelesen merken. */
export function rememberMail(m) {
  mailNow = isObj(m) ? { ...m } : null;
}
