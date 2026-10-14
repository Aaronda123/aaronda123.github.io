// hud.js – alles, was man sieht (ARCHITECTURE.md §3.2.7, §3.3, §9, §10).
// Zustände und Beschriftungen, Telemetrie, Protokoll, Timer, TERMINE, KONTO, SYS.DIAGNOSE, Weltuhren, Laufband mit
// Kursen, Panels zum Wischen mit Punkten, Links zum Antippen, Bild- und 3D-Box, Kugel greifen/ziehen/zoomen,
// Hinweis, Schleier, Einblenden, Freischalten, Startbildschirm, Tastatur. Besitzt die Instanzen von window.Orb
// (neuro.js), window.Galaxy (galaxy.js) und window.Model3D (model3d.js). Port der Darstellungsteile von ui/app.js am
// Mac (setState, renderWorld, renderCalendar, renderTimers, drawSpark, drawRing, renderIncome, renderTermine,
// renderMarkets, setPaused, tick, setFocus, Bild-Timer, Kugel greifen und zoomen).
// v4: setExternalTermine(list) merges Google events ({ title, start: Date, allDay, location }) into TERMINE;
// showLink(link) takes link.cls ("yes" | "no" | "google") and link.ms (how long it stays); dropLinks(prefix).
import { WEEKDAYS, MONTHS } from "./intents.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const body = document.body;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pad = (n) => String(n).padStart(2, "0");
const noop = () => {};

const LABELS = {
  loading: "BOOT", idle: "BEREIT", listening: "HÖRE ZU", transcribing: "VERSTEHE",
  thinking: "DENKE NACH", speaking: "SPRICHT", error: "FEHLER",
};
const STATES = Object.keys(LABELS);
const PLACEHOLDER_WAKE = "Frag Jarvis … oder sag „Hey Jarvis“";
const PLACEHOLDER_WAKE_SHORT = "Frag Jarvis … oder sag „Jarvis“";
const PLACEHOLDER_TYPE = "Frag Jarvis …";
let PLACEHOLDER = PLACEHOLDER_WAKE;
let wakeHintOn = true;
const MODEL_HINT_MOUSE = "ZIEHEN: DREHEN · MAUSRAD: ZOOM · DOPPELKLICK: ZURÜCK";
const HOTKEYS_MOUSE = "Kugel anklicken: zuhören / fertig · Doppelklick auf Schwarz: zurück";
const PAGES = ["clock", "termine", "log", "konto", "system", "control"];
const LOG_PAGE = 2;
const SYSTEM_PAGE = 4;
const KONTO_PAGE = 3;
const GAUGE_LEN = 2 * Math.PI * 26;
const ORB_KEY = "jarvis.v2.orb"; // store.KEYS.orb – hud schreibt und liest ihn selbst (§8.1)
const WHO = { user: "DU", jarvis: "JARVIS", tool: "AKTION", system: "SYSTEM", error: "FEHLER", draft: "ENTWURF" };
const MAX_LOG = 60;
const MAX_LINKS = 3;
const LINK_MS = 60000;
const MARKET_MS = 60000;
const MARKET_MAX_MS = 600000;
const PING_MS = 30000;
const FETCH_MS = 8000;
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

// Laufband (§9.7, D10): Binance je Symbol; Fallback CoinGecko / Frankfurter. Die Mac-Indizes (Yahoo) gibt es hier nicht.
const MARKETS = [
  { key: "BTC", name: "Bitcoin", sym: "BTCUSDT", dec: 0, cg: "bitcoin" },
  { key: "ETH", name: "Ethereum", sym: "ETHUSDT", dec: 0, cg: "ethereum" },
  { key: "GOLD", name: "Gold", sym: "PAXGUSDT", dec: 1, cg: "pax-gold" },
  { key: "EURUSD", name: "Euro / Dollar", sym: "EURUSDT", dec: 4, fx: true },
];
const BINANCE = "https://api.binance.com/api/v3/ticker/24hr?symbol=";
const COINGECKO = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,pax-gold&vs_currencies=usd&include_24hr_change=true";
const FRANKFURTER = "https://api.frankfurter.app/latest?from=EUR&to=USD";

// ---------------------------------------------------------------- Zustand des Moduls
let cb = {};
let inited = false;
let started = false;
let state = "loading";
let paused = false;
let orb = null;
let vorname = "";
let homeName = "HIER";
const bootAt = Date.now();
let lastMinute = -1;
let tickTimer = 0;
let pingTimer = 0;
let timerList = [];
let kontoData = null;
let page = LOG_PAGE; // Startseite PROTOKOLL (settings.deckPage, Standard 2)
let lastReported = LOG_PAGE; // zuletzt an app.js gemeldete Seite
let lastLatency = null;
let micPeak = 0;
const micHist = [];
const latHist = [];
let netPct = null;
let netRtt = null;
let reduced = false;

function call(name, ...args) {
  const fn = cb[name];
  if (typeof fn !== "function") return undefined;
  try {
    return fn(...args);
  } catch (e) {
    console.error(`hud: ${name}`, e);
    return undefined;
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function cssVar(name, fallback = "") {
  const v = getComputedStyle(root).getPropertyValue(name).trim();
  return v || fallback;
}

function themeRgb() { return cssVar("--c-rgb", "255, 42, 64").replace(/\s+/g, ""); }

const dprOf = () => Math.min(window.devicePixelRatio || 1, 2);

// Canvas auf CSS-Größe × DPR bringen; gibt [Breite, Höhe] in Gerätepixeln zurück (0 = unsichtbar)
function fitCanvas(cv) {
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return [0, 0];
  const d = dprOf();
  const W = Math.round(w * d), H = Math.round(h * d);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  return [W, H];
}

// ================================================================ init / start
export function init(callbacks = {}) {
  cb = callbacks || {};
  if (inited) return;
  inited = true;
  const standalone = navigator.standalone === true || !!window.matchMedia?.("(display-mode: standalone)").matches;
  body.classList.toggle("standalone", standalone);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const tip = document.querySelector("#boot .boot-tip");
  if (tip) tip.hidden = !(ios && !standalone);
  // Maus statt Finger (Rechner): Hinweise im 3D-Fenster und unter KOMMANDO passend (Mausrad, Klick, Doppelklick)
  const mouse = !!window.matchMedia?.("(pointer: fine)").matches && !window.matchMedia?.("(any-pointer: coarse)").matches;
  if (mouse && $("model3d-hint")) setText($("model3d-hint"), MODEL_HINT_MOUSE);
  const hotkeys = document.querySelector("#p-control .hotkeys");
  if (mouse && hotkeys) setText(hotkeys, HOTKEYS_MOUSE);

  if (window.Orb) {
    try {
      orb = new window.Orb($("orb"));
      orb.pause(true); // läuft erst mit start()
      orb.setPalette?.(root.dataset.theme || "mac");
      orb.setMode(state);
    } catch (e) {
      console.error("hud: Orb", e);
      orb = null;
    }
  }
  if (window.Model3D) window.Model3D.onClose = () => call("onModelClosed");

  loadOrb();
  bindImage();
  bindLog();
  bindStage();
  bindControls();
  bindDeck();
  bindVeil();
  bindKeyboard();
  sizeStage();
  if (window.ResizeObserver) new ResizeObserver(() => { sizeStage(); fitText(); }).observe($("stage-wrap"));
  window.addEventListener("resize", () => { sizeStage(); alignDeck(); updateKeyboard(); });
  window.addEventListener("orientationchange", () => setTimeout(() => { sizeStage(); alignDeck(); }, 250));
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { wakeMarkets(); ping(); }
  });
  const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  mq?.addEventListener?.("change", () => setReducedMotion(mq.matches));
  setOnline(navigator.onLine !== false);
  try { document.fonts?.ready?.then(() => { sizeStage(); fitPlaceholder(); updateMore(); fitText(); }); } catch { /* ignore */ }
  renderWorld(new Date());
  renderCalendar(new Date());
  renderKonto(null);
  renderTermine(null);
  setGauge("g-mic", 0);
  setGauge("g-lat", null);
  goToPage(page, false);
  requestAnimationFrame(() => goToPage(page, false));
}

export function start() {
  if (started) return;
  started = true;
  orb?.pause(paused);
  lastMinute = -1;
  tick();
  tickTimer = setInterval(tick, 1000);
  ping();
  pingTimer = setInterval(ping, PING_MS);
  wakeMarkets(true);
  setInterval(nudgeVeilHint, 60000);
}

// ================================================================ Thema, Marke
export function setTheme(name) {
  const t = name === "tuerkis" ? "tuerkis" : "mac";
  root.dataset.theme = t;
  orb?.setPalette?.(t);
  if (kontoData) drawKontoCanvases();
  drawDiag();
}

export function setBrand({ firma, wohnort, galaxyBrightness, vorname: vn } = {}) {
  if (firma !== undefined) {
    const f = String(firma || "").trim().toUpperCase();
    setText($("brand-sub"), f ? `${f} · COMMAND CENTER` : "COMMAND CENTER");
  }
  if (wohnort !== undefined) {
    const w = String(wohnort || "").trim().toUpperCase();
    homeName = w || "HIER";
    renderWorld(new Date());
  }
  if (galaxyBrightness !== undefined && galaxyBrightness !== null && Number.isFinite(Number(galaxyBrightness))) {
    // eigene Variable: --galaxy gehört der Kugel (wie weit sie zur Milchstraße aufgezogen ist, neuro.js)
    root.style.setProperty("--galaxy-bright", String(clamp(Number(galaxyBrightness), 0, 1)));
  }
  if (vn !== undefined) vorname = String(vn || "").trim();
}

// ================================================================ Zustand (Mac setState)
export function setState(next, detail, { soft = false } = {}) {
  void soft; // weiche Übergänge (Nachhören) unterscheiden sich nur bei den Tönen, die spielt app.js
  state = LABELS[next] ? next : "idle";
  for (const s of STATES) if (s !== state) body.classList.remove(`state-${s}`);
  body.classList.add(`state-${state}`);
  orb?.setMode(state);
  setText($("state-label"), LABELS[state]);
  setText($("top-state"), LABELS[state]);
  if (detail) setDetail(detail);
  if (state !== "idle") body.classList.remove("dim");
  if (state === "idle") {
    orb?.setLevel(0);
    setLive(null);
  } else if (state === "speaking") {
    setLive("Jarvis spricht …");
  } else {
    setLive(detail || LABELS[state]);
  }
}

export function setDetail(text) {
  const t = String(text ?? "");
  setText($("top-detail"), t);
  setText($("status"), t);
}

// Textbreite in der Schrift der Eingabezeile (Platzhalter kürzen, live das Ende zeigen)
let measureCtx = null;
function textWidth(text, input) {
  try {
    measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
    const cs = getComputedStyle(input);
    measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return measureCtx.measureText(String(text)).width;
  } catch {
    return 0;
  }
}

// Längerer Satz, als in die Zeile passt: das Neueste zeigen („…und Umgebung“), nicht den Anfang (visual-ux-3)
function fitTail(text, input) {
  const w = input.clientWidth - 6;
  if (w <= 0 || textWidth(text, input) <= w) return text;
  const open = text.startsWith("„") ? "„" : "";
  const close = open && text.endsWith("“") ? "“" : "";
  const inner = text.slice(open.length, text.length - close.length);
  let lo = 0;
  let hi = inner.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (textWidth(`${open}…${inner.slice(mid)}${close}`, input) <= w) hi = mid;
    else lo = mid + 1;
  }
  let tail = inner.slice(lo);
  const sp = tail.indexOf(" ");
  if (lo > 0 && sp >= 0 && sp < tail.length - 6) tail = tail.slice(sp + 1);     // an einer Wortgrenze
  return `${open}…${tail.trimStart()}${close}`;
}

// Die Eingabezeile zeigt live, was Jarvis gerade hört oder tut (null = Ruhe)
let liveText = null;
export function setLive(text) {
  liveText = text || null;
  const input = $("ask-input");
  $("ask-form").classList.toggle("live", !!text);
  input.placeholder = text ? fitTail(String(text), input) : PLACEHOLDER;
}

// Platzhalter, der in die Zeile passt (schmale Handys: ohne „Hey“, ganz schmal nur „Frag Jarvis …“, visual-ux-8)
function fitPlaceholder() {
  const input = $("ask-input");
  if (!input) return;
  const list = wakeHintOn ? [PLACEHOLDER_WAKE, PLACEHOLDER_WAKE_SHORT, PLACEHOLDER_TYPE] : [PLACEHOLDER_TYPE];
  const w = input.clientWidth - 6;
  let next = list[list.length - 1];
  for (const c of list) {
    if (w <= 0 || textWidth(c, input) <= w) { next = c; break; }
  }
  const showing = !liveText;
  PLACEHOLDER = next;
  if (showing) input.placeholder = PLACEHOLDER;
  else input.placeholder = fitTail(liveText, input);
}

/** Platzhalter der Eingabezeile mit oder ohne „Hey Jarvis“ (ohne Weckwort, z. B. Firefox oder Mikrofon gesperrt). */
export function setWakeHint(on) {
  wakeHintOn = !!on;
  fitPlaceholder();
}

export function setTelemetry({ mic, wake, core, latencyMs } = {}) {
  if (mic !== undefined) setText($("t-mic"), String(mic ?? "—"));
  if (wake !== undefined) setText($("t-wake"), String(wake ?? "—"));
  if (core !== undefined) setText($("t-core"), String(core ?? "—"));
  if (latencyMs !== undefined) setLatency(latencyMs);
}

function fmtSeconds(ms) { return `${(ms / 1000).toFixed(1).replace(".", ",")} s`; }

function setLatency(ms) {
  const v = Number(ms);
  if (ms == null || !Number.isFinite(v) || v < 0) {
    lastLatency = null;
    setText($("t-lat"), "—");
  } else {
    lastLatency = v;
    setText($("t-lat"), fmtSeconds(v));
  }
  updateGauges();
}

export function setAuth(text, ok) {
  const a = $("auth-state");
  setText(a, String(text || ""));
  a.style.color = ok ? "var(--green)" : "var(--amber)";
}

export function setLevel(level, bands) {
  void bands; // der Neuronen-Ball nutzt nur den Gesamtpegel
  const v = clamp(Number(level) || 0, 0, 1);
  orb?.setLevel(v);
  if (state === "listening" || state === "transcribing") micPeak = Math.max(micPeak, v);
}

// ================================================================ Protokoll
function whoLabel(kind, at) {
  const base = kind === "user" ? (vorname ? vorname.toUpperCase() : "DU") : (WHO[kind] || "SYSTEM");
  const d = new Date(Number(at) || Date.now());
  return `${base} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function logRow(kind, text, at) {
  const k = WHO[kind] ? kind : "system";
  const row = el("div", `entry ${k}`);
  row.append(el("span", "who", whoLabel(k, at)), el("span", "msg", String(text ?? "")));
  return row;
}

// Der neueste Satz von dir oder Jarvis steht voll da und hervorgehoben; ältere Einträge sind gekürzt (style.css)
function markNewest() {
  const box = $("log");
  const rows = [...box.querySelectorAll(".entry.jarvis, .entry.user, .entry.error, .entry.draft")];
  const last = rows[rows.length - 1] || null;
  for (const r of box.querySelectorAll(".entry.newest")) if (r !== last) r.classList.remove("newest");
  if (last) last.classList.add("newest");
}

export function log(kind, text, at = Date.now()) {
  const box = $("log");
  box.appendChild(logRow(kind, text, at));
  while (box.children.length > MAX_LOG) box.firstChild.remove();
  markNewest();
  logStick = true;
  logToEnd();
  if (page !== LOG_PAGE && pagedDeck()) dotButtons()[LOG_PAGE]?.classList.add("badge");
}

// Das Protokoll klebt unten (Mac). Ist das Panel gerade nicht gerendert (Tastatur offen, „Nur Kugel“, ausgeblendet),
// wirkt scrollTop nicht – deshalb nach jedem Layoutwechsel noch einmal ans Ende, solange niemand hochgescrollt hat.
let logStick = true;
function logToEnd() {
  const box = $("log");
  if (logStick && box) box.scrollTop = box.scrollHeight;
}
function relayout() {
  requestAnimationFrame(() => { alignDeck(); logToEnd(); placeToast(); updateMore(); });   // Deck war evtl. nicht gerendert
}

// „▾“ unten an einem Panel (bzw. ein Ausblenden am Raster), solange darunter noch etwas kommt: auf Touch-Geräten gibt es
// keine sichtbare Bildlaufleiste, sonst wirkt z. B. KOMMANDO ohne ⚙ wie abgeschnitten (visual-ux-9)
function updateMore() {
  for (const p of pageEls()) {
    if (p.id === "p-log") continue;                      // das Protokoll scrollt in sich und steht am Ende
    const more = p.clientHeight > 0 && p.scrollHeight - p.clientHeight - p.scrollTop > 6;
    if (p.classList.contains("more") !== more) p.classList.toggle("more", more);
  }
  const deck = $("deck");
  const vertical = deck.scrollHeight - deck.clientHeight > 6 && getComputedStyle(deck).overflowY === "auto";
  const more = vertical && deck.scrollHeight - deck.clientHeight - deck.scrollTop > 6;
  if (deck.classList.contains("more") !== more) deck.classList.toggle("more", more);
}

// Ältere Einträge sind auf drei Zeilen gekürzt: Antippen zeigt sie ganz (und wieder kurz)
function bindLog() {
  $("log").addEventListener("click", (e) => {
    const en = e.target.closest?.(".entry");
    if (!en || en.classList.contains("newest") || en === $("log").lastElementChild) return;
    if (String(window.getSelection?.() || "").trim()) return;   // Text markiert: nicht umklappen
    en.classList.toggle("open");
  });
}

export function restoreLog(entries) {
  const list = Array.isArray(entries) ? entries.slice(-MAX_LOG) : [];
  const rows = list.filter((e) => e && typeof e === "object").map((e) => {
    const r = logRow(e.kind, e.text, e.at);
    r.style.animation = "none";
    return r;
  });
  $("log").replaceChildren(...rows);
  markNewest();
  logStick = true;
  logToEnd();
}

/**
 * Nach dem Neuladen die letzte Stunde Gespräch zeigen (Mac „history“, 13.10. abends) – nur, wenn im Protokoll noch
 * kein Satz von dir oder Jarvis steht (z. B. nach „Protokoll leeren“). Nur Anzeige, nichts wird gespeichert.
 * @param {{ who: "user"|"jarvis", text: string, at?: number }[]} items
 * @returns {boolean} true = angezeigt
 */
export function restoreHistory(items) {
  const box = $("log");
  if (box.querySelector(".entry.user, .entry.jarvis")) return false;
  const list = (Array.isArray(items) ? items : []).filter((e) => e && String(e.text || "").trim()).slice(-40);
  if (!list.length) return false;
  for (const e of list) {
    const r = logRow(e.who === "user" ? "user" : "jarvis", String(e.text).trim(), e.at);
    r.style.animation = "none";
    box.appendChild(r);
  }
  while (box.children.length > MAX_LOG) box.firstChild.remove();
  markNewest();
  logStick = true;
  logToEnd();
  return true;
}

// ================================================================ Timer (Mac renderTimers, in place: Bug 4)
function timerText(t, now) {
  const left = Math.max(0, Math.round((Number(t.ends) - now) / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = String(left % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function renderTimers(timers, now = Date.now()) {
  timerList = Array.isArray(timers) ? timers.filter((t) => t && t.id != null) : [];
  const box = $("timers");
  const have = new Map([...box.children].map((r) => [r.dataset.id, r]));
  const t0 = Number(now) || Date.now();
  timerList.forEach((t, i) => {
    const id = String(t.id);
    let row = have.get(id);
    if (!row) {
      row = el("button", "timer");
      row.type = "button";
      row.dataset.id = id;
      row.append(el("span", "tl"), el("span", "tt"));
    }
    have.delete(id);
    if (box.children[i] !== row) box.insertBefore(row, box.children[i] || null);
    const label = `⏱︎ ${t.label || "Timer"}`;
    setText(row.firstChild, label);
    setText(row.lastChild, timerText(t, t0));
    row.setAttribute("aria-label", `${t.label || "Timer"} löschen`);
  });
  for (const row of have.values()) row.remove();
}

function refreshTimerTexts(now) {
  const box = $("timers");
  for (const row of box.children) {
    const t = timerList.find((x) => String(x.id) === row.dataset.id);
    if (t) setText(row.lastChild, timerText(t, now));
  }
}

// ================================================================ Uhr, Weltuhren, Kalender (Mac tick)
const zoneFmt = {};
function zoneTime(tz, now) {
  const key = tz || "local";
  const f = zoneFmt[key] || (zoneFmt[key] = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz || undefined, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }));
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
    min: hour * 60 + Number(p.minute), text: `${String(hour).padStart(2, "0")}:${p.minute}`, hour };
}

function worldList() {
  return [[homeName, null], ["LONDON", "Europe/London"], ["NEW YORK", "America/New_York"], ["TOKIO", "Asia/Tokyo"]];
}

function renderWorld(now) {
  const box = $("worldclocks");
  const list = worldList();
  if (box.children.length !== list.length) box.replaceChildren(...list.map(() => el("div", "wc")));
  list.forEach(([name, tz], i) => {
    const z = zoneTime(tz, now);
    const c = box.children[i];
    c.className = "wc" + (z.hour < 7 || z.hour >= 22 ? " night" : "");
    c.replaceChildren(el("span", "", name), el("b", "", z.text));
  });
}

function renderCalendar(now) {
  const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const wd = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - wd);
  const kw = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  const y = now.getFullYear();
  const days = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
  const doy = Math.floor((Date.UTC(y, now.getMonth(), now.getDate()) - Date.UTC(y, 0, 0)) / 86400000);
  setText($("kw"), `KW ${kw}`);
  setText($("doy"), `TAG ${doy}/${days}`);
  $("yearfill").style.width = `${(doy / days) * 100}%`;
}

function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `UPTIME ${d}T ${h}H` : `UPTIME ${h}H ${m}M`;
}

function tick() {
  if (paused) return; // ausgeblendet: Uhr und Panels erst beim Einblenden wieder aktualisieren
  const now = new Date();
  if (now.getMinutes() !== lastMinute) { // Weltuhren, Termine, Kalender ändern sich nur minütlich (Bug 35)
    lastMinute = now.getMinutes();
    renderWorld(now);
    renderTermineList(now);
    renderCalendar(now);
    setText($("uptime"), fmtUptime(Math.floor((Date.now() - bootAt) / 1000)));
  }
  const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  setText($("topclock"), hm);
  setText($("time"), hm);
  setText($("sec"), pad(now.getSeconds()));
  setText($("date"), `${WEEKDAYS[now.getDay()]}, ${now.getDate()}. ${MONTHS[now.getMonth()]} ${now.getFullYear()}`);
  if (timerList.length) refreshTimerTexts(now.getTime());
  sampleDiag();
  updateMore();
}

// ================================================================ KONTO (Mac renderIncome, live app.js L470-550)
const fmtNum = (v, dec) => (v == null || !Number.isFinite(Number(v)) ? "–"
  : Number(v).toLocaleString("de-DE", { minimumFractionDigits: dec, maximumFractionDigits: dec }));
const eur = (v, dec = 2) => (v == null ? "–" : Number(v).toLocaleString("de-DE",
  { style: "currency", currency: "EUR", minimumFractionDigits: dec, maximumFractionDigits: dec }));
const usd = (v, dec = 0) => (v == null ? "–" : Number(v).toLocaleString("de-DE",
  { style: "currency", currency: "USD", minimumFractionDigits: dec, maximumFractionDigits: dec }));
const coinPrices = {}; // Schlüssel (BTC, SOL$ …) → { price, change, at } – nur Anzeige, nie gespeichert

function drawSpark(cv, data, up) {
  const [w, h] = fitCanvas(cv);
  if (!w) return;
  const c = cv.getContext("2d");
  const d = dprOf();
  c.clearRect(0, 0, w, h);
  const list = Array.isArray(data) ? data.map(Number).filter(Number.isFinite) : [];
  if (list.length < 2) {
    c.fillStyle = "rgba(201,141,144,.5)";
    c.font = `600 ${Math.round(12 * d)}px Rajdhani, sans-serif`;
    c.fillText("kein Verlauf", 4 * d, h / 2 + 4 * d);
    return;
  }
  const min = Math.min(...list);
  const max = Math.max(...list);
  const span = max - min || 1;
  const color = up ? "92,255,182" : "255,84,104";
  c.beginPath();
  list.forEach((v, i) => {
    const x = (i / (list.length - 1)) * w;
    const y = h - 3 * d - ((v - min) / span) * (h - 6 * d);
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  });
  c.strokeStyle = `rgba(${color},.95)`;
  c.lineWidth = 1.6 * d;
  c.lineJoin = "round";
  c.stroke();
  c.lineTo(w, h);
  c.lineTo(0, h);
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `rgba(${color},.25)`);
  g.addColorStop(1, `rgba(${color},0)`);
  c.fillStyle = g;
  c.fill();
}

function drawRing(p) {
  const cv = $("kt-ring");
  const [w] = fitCanvas(cv);
  if (!w) return;
  const c = cv.getContext("2d");
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  c.setTransform(w / 96, 0, 0, w / 96, 0, 0); // Mac-Maße (96 × 96)
  const rgb = themeRgb();
  const main = cssVar("--cyan", "#ff2a40");
  c.lineWidth = 8;
  c.strokeStyle = `rgba(${rgb},.12)`;
  c.beginPath(); c.arc(48, 48, 38, 0, 7); c.stroke();
  if (p > 0.001) {
    c.strokeStyle = main; c.shadowColor = main; c.shadowBlur = 12; c.lineCap = "round";
    c.beginPath(); c.arc(48, 48, 38, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, p)); c.stroke();
    c.shadowBlur = 0;
  }
  c.fillStyle = cssVar("--text", "#ffeceb"); c.font = "700 17px Orbitron, sans-serif"; c.textAlign = "center";
  c.fillText(`${Math.round(p * 100)}%`, 48, 54);
}

let kontoDraw = { goal: 0, month: 0, verlauf: null, up: true };
function drawKontoCanvases() {
  drawRing(kontoDraw.goal ? kontoDraw.month / kontoDraw.goal : 0);
  drawSpark($("kt-spark"), kontoDraw.verlauf, kontoDraw.up);
}

// Wallets mit Live-Kurs (Mac income_with_crypto, live jarvis.py L5226-5253), nur für die Anzeige
function cryptoRows(d) {
  return (Array.isArray(d.krypto) ? d.krypto : []).filter((c) => c && typeof c === "object").map((c0) => {
    const c = { ...c0 };
    const sym = String(c.symbol || "").toUpperCase();
    const usdWallet = c.usd != null && c.menge == null;
    const pr = coinPrices[usdWallet ? `${sym}$` : sym];
    if (!pr) {
      if (usdWallet) { c.wert = Number(c.usd); c.waehrung = "USD"; } // ohne Kurs trotzdem den festen Betrag zeigen
      return c;
    }
    c.change = pr.change;
    if (usdWallet) {
      c.menge = Number(c.usd) / pr.price; c.wert = Number(c.usd); c.waehrung = "USD";
      return c;
    }
    c.preis_eur = pr.price;
    if (c.menge != null) c.wert = Number(c.menge) * pr.price;
    else if (c.eur != null) { c.menge = Number(c.eur) / pr.price; c.wert = Number(c.eur); }
    return c;
  });
}

// Echte Geldangaben? Ein Konto-Objekt nur mit Terminen zeigt weiter „Noch keine Werte“ (kein erfundenes 0,00 €).
function hasMoney(k) {
  if (!k) return false;
  const n = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  const list = (v) => Array.isArray(v) && v.length > 0;
  return n(k.kontostand) || list(k.quellen) || list(k.konten) || list(k.krypto) || list(k.buchungen)
    || (n(k.ziel_monat) && Number(k.ziel_monat) > 0) || (n(k.heute) && Number(k.heute) !== 0);
}

export function renderKonto(konto) {
  const full = konto && typeof konto === "object" ? konto : null;
  kontoData = full;                                         // TERMINE liest daraus, auch ohne Geldangaben
  const d = hasMoney(full) ? full : null;
  const sources = d && Array.isArray(d.quellen) ? d.quellen.filter((q) => q && typeof q === "object") : [];
  setText($("inc-stand"), d ? `STAND ${d.stand || "—"}` : "KEINE DATEN");
  document.querySelector("#p-konto .kt-empty").hidden = !!d;
  document.querySelector("#p-konto .kt-body").hidden = !d;
  if (!d) {
    $("p-konto").classList.remove("has-konten");
    renderTermineList(new Date());
    return;
  }
  // KONTO mit dem Kontostand, darunter kleine Zeilen; in Dollar, wenn "waehrung": "USD" (dann auch die Einnahmen)
  const accounts = Array.isArray(d.konten) ? d.konten.filter((a) => a && typeof a === "object") : [];
  const money = d.waehrung === "USD" ? usd : eur;
  const known = d.kontostand !== null && d.kontostand !== undefined && d.kontostand !== "";
  const konto0 = known ? Number(d.kontostand) || 0 : null;
  const prev = Number(d.kontostand_vortag) || 0;
  const diff = prev && known ? konto0 - prev : null;
  const dec = d.waehrung === "USD" ? 0 : 2;
  setText($("kt-konto-lbl"), accounts.length ? "KONTO" : "KONTOSTAND");
  $("p-konto").classList.toggle("has-konten", accounts.length > 0);
  setText($("kt-konto"), money(konto0, dec));
  setText($("kt-chg"), diff == null ? "" : `${diff >= 0 ? "▲ +" : "▼ "}${money(diff, dec)} · ${fmtNum(diff / prev * 100, 1)} %`);
  $("kt-chg").className = "kt-chg " + (diff == null || diff >= 0 ? "up" : "down");
  setText($("kt-heute"), `+${money(d.heute || 0)}`);
  $("kt-konten").replaceChildren(...accounts.map((a) => {
    const r = el("div", "acc");
    r.append(el("span", "nm", a.name || "Konto"), el("b", "", money(a.wert, 0)));
    return r;
  }));
  setText($("kt-zahl"), `${d.zahlungen_heute || 0} Zahlungen`);
  const month = sources.reduce((s, q) => s + (Number(q.monat) || 0), 0);
  const goal = Number(d.ziel_monat) || 0;
  setText($("kt-monat"), money(month, 0));
  setText($("kt-ziel"), goal ? `Ziel ${money(goal, 0)}` : "");
  kontoDraw = { goal, month, verlauf: d.verlauf, up: diff == null || diff >= 0 };
  drawKontoCanvases();
  requestAnimationFrame(drawKontoCanvases);
  const max = Math.max(1, ...sources.map((q) => Number(q.monat) || 0));
  $("kt-src").replaceChildren(...sources.map((q) => {
    const r = el("div", "src");
    const bar = el("div", "bar");
    const fill = el("i");
    fill.style.width = `${((Number(q.monat) || 0) / max) * 100}%`;
    bar.append(fill);
    r.append(el("span", "nm", q.name || "Quelle"), el("b", "", money(q.monat, 0)), bar);
    return r;
  }));
  // Krypto-Wallets: Menge aus dem Konto, Wert und 24-h-Änderung live (Binance)
  const coins = cryptoRows(d);
  $("kt-krypto").replaceChildren(...(coins.length ? [el("span", "kt-lbl", "KRYPTO · WALLETS")] : []), ...coins.map((c) => {
    const sym = String(c.symbol || "").toUpperCase();
    const amount = Number(c.menge);
    const value = c.wert != null ? Number(c.wert) : Number(c.eur);
    const chg = c.change != null ? Number(c.change) : NaN;
    const r = el("div", "coin");
    r.append(el("i", "ic " + sym.toLowerCase(), sym === "BTC" ? "₿" : sym === "SOL" ? "◎" : "◆"),
      el("span", "nm", c.name || sym),
      el("b", "", !Number.isFinite(value) ? "–" : c.waehrung === "USD" ? value.toLocaleString("de-DE",
        { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : eur(value, 0)),
      el("span", "amt", Number.isFinite(amount) ? `${fmtNum(amount, amount < 10 ? 4 : 2)} ${sym}` : ""),
      el("span", "chg " + (chg >= 0 ? "up" : "down"), Number.isFinite(chg) ? `${chg >= 0 ? "▲ +" : "▼ "}${fmtNum(chg, 1)} % · 24 h` : ""));
    return r;
  }));
  renderTermineList(new Date());
  if (coins.length && started) wakeMarkets();
}

// ================================================================ TERMINE (Mac renderTermine, live app.js L553-577)
function fmtDur(min) {
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return `${d}T ${h}h`;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function renderTermine(konto, now = new Date()) {
  if (konto !== undefined) kontoData = konto && typeof konto === "object" ? konto : null;
  renderTermineList(now instanceof Date ? now : new Date(now));
}

// v4: Termine aus dem Google-Kalender (app.js lädt sie über google.js), gemischt mit der Jarvis-Liste
let extTermine = [];
export function setExternalTermine(list, now = new Date()) {
  extTermine = (Array.isArray(list) ? list : []).filter((e) => e && e.start instanceof Date && !isNaN(e.start))
    .map((e) => ({ titel: String(e.title || "Termin"), ort: String(e.location || ""), at: new Date(e.start.getTime()),
      allDay: !!e.allDay, google: true }));
  renderTermineList(now instanceof Date ? now : new Date(now));
}

function renderTermineList(now) {
  const income = kontoData;
  const own = (income && Array.isArray(income.termine) ? income.termine : [])
    .filter((t) => t && typeof t === "object")
    .map((t) => ({ ...t, at: new Date(t.wann), allDay: !String(t.wann).includes("T") }));
  const seen = new Set(extTermine.map((t) => `${t.titel.toLowerCase()}|${t.at.getTime()}`));
  const list = [...extTermine.map((t) => ({ ...t, at: new Date(t.at.getTime()) })),
    ...own.filter((t) => !seen.has(`${String(t.titel || "").toLowerCase()}|${t.at.getTime()}`))]
    .filter((t) => !isNaN(t.at) && (t.allDay ? new Date(t.at.getTime()).setHours(23, 59) : t.at) >= now - 3600e3)
    .sort((a, b) => a.at - b.at).slice(0, 3);
  const hints = income && Array.isArray(income.hinweise) ? income.hinweise.slice(0, 2) : [];
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rows = list.map((t, i) => {
    const d = new Date(t.at.getFullYear(), t.at.getMonth(), t.at.getDate());
    const days = Math.round((d - day0) / 86400e3);
    const when = days === 0 ? "HEUTE" : days === 1 ? "MORGEN" : `${WD[t.at.getDay()].toUpperCase()} ${t.at.getDate()}.${t.at.getMonth() + 1}.`;
    const time = t.allDay ? "GANZTÄGIG" : `${pad(t.at.getHours())}:${pad(t.at.getMinutes())}`;
    const r = el("div", "ev" + (i ? " b2" : "") + (t.google ? " g" : ""));
    const txt = el("div", "tx");
    txt.append(el("span", "when", `${when} · ${time}`), el("span", "what", t.titel || "Termin"));
    if (t.ort) txt.append(el("span", "where", t.ort));
    const left = t.allDay ? days : Math.round((t.at - now) / 60000);
    const cd = t.allDay ? (days <= 0 ? "heute" : `in ${days} T`) : left < 0 ? "läuft" : `in ${fmtDur(left)}`;
    r.append(el("i", "bar"), txt, el("span", "cd", cd));
    return r;
  });
  hints.forEach((h) => rows.push(el("div", "hint", `⚠ ${h}`)));
  if (!rows.length) {
    rows.push(el("div", "hint", "Keine Termine in nächster Zeit."));
    rows.push(el("div", "say", "Sag z. B. „Trag Zahnarzt Donnerstag um 15 Uhr ein“."));
  }
  $("termine").replaceChildren(...rows);
  setText($("ter-count"), list.length ? `${list.length} ANSTEHEND` : "—");
}

// ================================================================ SYS.DIAGNOSE
function setGauge(id, pct, label) {
  const g = $(id);
  if (!g) return;
  const p = pct == null ? 0 : clamp(pct, 0, 100);
  g.querySelector(".bar").style.strokeDashoffset = String(GAUGE_LEN * (1 - p / 100));
  setText(g.querySelector("b"), label ?? (pct == null ? "--" : `${Math.round(p)}%`));
}

function gaugeClass(id, warn, crit) {
  const g = $(id);
  g.classList.toggle("warn", !!warn && !crit);
  g.classList.toggle("crit", !!crit);
}

function updateGauges() {
  const mic = micHist.length ? micHist[micHist.length - 1] : 0;
  setGauge("g-mic", mic);
  if (!navigator.onLine) { setGauge("g-net", 0, "OFF"); gaugeClass("g-net", false, true); }
  else if (netPct == null) { setGauge("g-net", null); gaugeClass("g-net", false, false); }
  else { setGauge("g-net", netPct); gaugeClass("g-net", netPct <= 40, netPct <= 15); }
  if (lastLatency == null) { setGauge("g-lat", null); gaugeClass("g-lat", false, false); }
  else {
    const p = clamp(lastLatency / 100, 0, 100); // 10 s = 100 %
    setGauge("g-lat", p, fmtSeconds(lastLatency).replace(" ", ""));
    gaugeClass("g-lat", p >= 50, p >= 80);
  }
}

function sampleDiag() {
  micHist.push(Math.round(micPeak * 100));
  micPeak = 0;
  latHist.push(lastLatency == null ? 0 : clamp(lastLatency / 100, 0, 100));
  if (micHist.length > 60) micHist.shift();
  if (latHist.length > 60) latHist.shift();
  if (page === SYSTEM_PAGE || !pagedDeck()) { updateGauges(); drawDiag(); }
}

// Tablet und Rechner (CR3.2): alle Panels gleichzeitig sichtbar, keine Seiten (die Punkte sind dann ausgeblendet)
function pagedDeck() {
  const t = $("deck-track");
  if (!t) return false;
  const cs = getComputedStyle(t);
  return cs.display === "flex" && cs.flexWrap === "nowrap";   // Handy: Seiten zum Wischen; Raster/Spalten sonst
}

// Verlauf: Mikrofon (Akzentfarbe, mit Fläche) und Latenz (helle Zweitfarbe) – Stil von Mac drawCpuGraph
function drawDiag() {
  const cv = $("diag-graph");
  const [w, h] = fitCanvas(cv);
  if (!w) return;
  const c = cv.getContext("2d");
  const d = dprOf();
  c.clearRect(0, 0, w, h);
  if (micHist.length < 2) return;
  const step = w / 59;
  const rgb = themeRgb();
  const sky = cssVar("--sky", "#ff806e");
  [[latHist, sky, null], [micHist, `rgba(${rgb},.95)`, `rgba(${rgb},.1)`]].forEach(([hist, line, fill]) => {
    c.beginPath();
    hist.forEach((v, i) => {
      const x = w - (hist.length - 1 - i) * step;
      const y = h - 3 * d - (v / 100) * (h - 6 * d);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    });
    c.globalAlpha = fill ? 1 : 0.75;
    c.strokeStyle = line;
    c.lineWidth = 1.5 * d;
    c.lineJoin = "round";
    c.stroke();
    c.globalAlpha = 1;
    if (!fill) return;
    c.lineTo(w, h);
    c.lineTo(w - (hist.length - 1) * step, h);
    c.fillStyle = fill;
    c.fill();
  });
}

function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "–";
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${(v / 1000).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} K`;
  return `${(v / 1e6).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} M`;
}

export function setDiagnostics({ tokensIn, tokensOut, requests, latencyMs, input, output } = {}) {
  void requests;
  const tin = tokensIn ?? input; // store.usageToday() liefert {input, output, requests}
  const tout = tokensOut ?? output;
  if (tin !== undefined) setText($("tok-in"), fmtTokens(tin));
  if (tout !== undefined) setText($("tok-out"), fmtTokens(tout));
  if (latencyMs !== undefined) setLatency(latencyMs);
}

function setOnline(on) {
  body.classList.toggle("offline", !on);
  setText($("diag-state"), on ? "ONLINE" : "OFFLINE");
  if (!on) netPct = 0;
  updateGauges();
  if (on) ping();
}

// Netz: Laufzeit zum eigenen Server, alle 30 s solange sichtbar (§9.8)
let pingBusy = false;
async function ping() {
  // ausgeblendet oder still im Hintergrund (Nachttisch): keine Messung, die keiner sieht (robustness-14)
  if (!started || pingBusy || paused || root.classList.contains("is-hidden") || document.visibilityState !== "visible") return;
  if (!navigator.onLine) { setOnline(false); return; }
  pingBusy = true;
  const t0 = performance.now();
  try {
    const r = await fetchWithTimeout(`manifest.webmanifest?ping=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    netRtt = performance.now() - t0;
    netPct = netRtt <= 150 ? 100 : netRtt >= 2000 ? 10 : 100 - ((netRtt - 150) / 1850) * 90;
  } catch {
    netRtt = null;
    netPct = navigator.onLine ? 10 : 0;
  } finally {
    pingBusy = false;
  }
  updateGauges();
}

// ================================================================ Laufband + Kurse (§9.7, Bug 33/34)
const marketData = {};
let marketTimer = 0;
let marketDelay = MARKET_MS;
let marketAt = 0;
let marketBusy = false;

async function fetchWithTimeout(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getJson(url) {
  const r = await fetchWithTimeout(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function marketsActive() {
  return started && document.visibilityState === "visible" && !root.classList.contains("is-hidden");
}

function scheduleMarkets(ms) {
  clearTimeout(marketTimer);
  marketTimer = setTimeout(pollMarkets, ms);
}

function wakeMarkets(force = false) {
  if (!marketsActive() || marketBusy) return;
  if (force || Date.now() - marketAt >= marketDelay) pollMarkets();
}

async function pollMarkets() {
  clearTimeout(marketTimer);
  marketTimer = 0;
  if (!marketsActive() || marketBusy) return; // unsichtbar: nichts abfragen, wakeMarkets() holt es nach
  marketBusy = true;
  let ok = 0;
  try {
    const res = await Promise.allSettled(MARKETS.map((m) => getJson(BINANCE + m.sym)));
    const missing = [];
    res.forEach((r, i) => {
      const m = MARKETS[i];
      const price = r.status === "fulfilled" ? Number(r.value?.lastPrice) : NaN;
      if (Number.isFinite(price) && price > 0) {
        const ch = Number(r.value.priceChangePercent);
        marketData[m.key] = { price, change: Number.isFinite(ch) ? ch : null };
        ok += 1;
      } else missing.push(m);
    });
    if (missing.some((m) => m.cg)) { // Binance gesperrt (451) oder weg: CoinGecko
      try {
        const j = await getJson(COINGECKO);
        for (const m of missing.filter((x) => x.cg)) {
          const v = j?.[m.cg];
          const price = Number(v?.usd);
          if (Number.isFinite(price) && price > 0) {
            const ch = Number(v.usd_24h_change);
            marketData[m.key] = { price, change: Number.isFinite(ch) ? ch : null };
            ok += 1;
          }
        }
      } catch { /* bleibt beim letzten Stand */ }
    }
    if (missing.some((m) => m.fx)) { // Euro/Dollar ohne Binance: Frankfurter (ohne Tagesänderung)
      try {
        const j = await getJson(FRANKFURTER);
        const price = Number(j?.rates?.USD);
        if (Number.isFinite(price) && price > 0) { marketData.EURUSD = { price, change: null }; ok += 1; }
      } catch { /* bleibt beim letzten Stand */ }
    }
    await pollCoins();
  } catch (e) {
    console.error("hud: Kurse", e);
  } finally {
    marketBusy = false;
  }
  marketAt = Date.now();
  if (ok) marketDelay = MARKET_MS;
  else marketDelay = Math.min(MARKET_MAX_MS, marketDelay * 2); // Fehler: ×2 bis 10 min
  if (!paused) renderTicker();
  if (marketsActive()) scheduleMarkets(marketDelay);
}

// Krypto-Wallets im KONTO: <SYM>EUR, Dollar-Wallets <SYM>USDT (Mac income_with_crypto)
async function pollCoins() {
  const d = kontoData;
  const coins = d && Array.isArray(d.krypto) ? d.krypto.filter((c) => c && typeof c === "object") : [];
  if (!coins.length) return;
  const jobs = [];
  for (const c of coins) {
    const sym = String(c.symbol || "").toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(sym)) continue;
    const usdWallet = c.usd != null && c.menge == null;
    const key = usdWallet ? `${sym}$` : sym;
    const pair = usdWallet ? `${sym}USDT` : `${sym}EUR`;
    if (coinPrices[key] && Date.now() - coinPrices[key].at < 50000) continue;
    jobs.push(getJson(BINANCE + pair).then((day) => {
      const price = Number(day?.lastPrice);
      const ch = Number(day?.priceChangePercent);
      if (Number.isFinite(price) && price > 0) coinPrices[key] = { price, change: Number.isFinite(ch) ? ch : null, at: Date.now() };
    }).catch(() => { /* ohne Kurs: fester Betrag bzw. – */ }));
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
  if (kontoData === d && !paused) renderKonto(d);
}

function chipText(m) {
  const it = marketData[m.key];
  const up = (it.change || 0) >= 0;
  return {
    price: `${fmtNum(it.price, m.dec)} `,
    change: it.change == null ? "" : `${up ? "▲" : "▼"} ${fmtNum(Math.abs(it.change), 2)} %`,
    cls: up ? "up" : "down",
  };
}

function renderTicker() {
  const items = MARKETS.filter((m) => marketData[m.key]);
  if (!items.length) return; // „KURSE WERDEN GELADEN …“ bleibt stehen
  const track = $("ticker");
  const sig = items.map((m) => m.key).join(",");
  if (track.dataset.keys !== sig) { // nur bei neuen Symbolen neu aufbauen; sonst Text in place (Bug 34)
    const make = (m) => {
      const s = el("span", "tk");
      s.dataset.key = m.key;
      s.append(el("b", "", m.key), document.createTextNode(""), el("span", ""));
      return s;
    };
    track.replaceChildren(...items.map(make), ...items.map(make)); // zweimal: läuft nahtlos durch
    track.dataset.keys = sig;
    track.style.setProperty("--dur", `${Math.max(30, items.length * 7)}s`);
  }
  for (const chip of track.children) {
    const m = MARKETS.find((x) => x.key === chip.dataset.key);
    if (!m || !marketData[m.key]) continue;
    const t = chipText(m);
    if (chip.childNodes[1].nodeValue !== t.price) chip.childNodes[1].nodeValue = t.price;
    const ch = chip.childNodes[2];
    setText(ch, t.change);
    if (ch.className !== t.cls) ch.className = t.cls;
  }
}

// ================================================================ Links zum Antippen
const links = [];
function cutLabel(s) {
  const t = String(s || "").trim();
  return t.length > 32 ? `${t.slice(0, 31)}…` : t;
}

// Links oder Hinweis sichtbar: Telemetrie unter der Kugel blendet aus (body.has-links / body.toast-on, style.css)
function syncLinkClass() {
  body.classList.toggle("has-links", links.length > 0);
  placeToast();
}

export function showLink(link) {
  if (!link || !link.url) return;
  const bar = $("actionbar");
  const old = links.find((l) => l.link.url === link.url);
  if (old) removeLink(old);
  while (links.length >= MAX_LINKS) removeLink(links[0]);
  const a = el("a", `act${link.cls ? ` ${link.cls}` : ""}`, `${link.icon || "↗"} ${cutLabel(link.label || link.url)}`);
  a.href = link.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = String(link.label || link.url);
  const entry = { link, a, timer: 0 };
  // iOS öffnet den Link selbst (echter <a>-Link, zuverlässig auch für tel: und Apps); app.js erfährt nur davon.
  // Interne Knöpfe („#jarvis-…“: Ja/Nein, Google verbinden) öffnen nichts; app.js handelt synchron im Tippen.
  a.addEventListener("click", () => call("onLinkTap", link));
  const ms = Number(link.ms) > 0 ? Math.min(600000, Number(link.ms)) : LINK_MS;
  entry.timer = setTimeout(() => removeLink(entry), ms);
  links.push(entry);
  bar.appendChild(a);
  syncLinkClass();
}

function removeLink(entry) {
  clearTimeout(entry.timer);
  entry.a.remove();
  const i = links.indexOf(entry);
  if (i >= 0) links.splice(i, 1);
  syncLinkClass();
}

export function clearLinks() {
  while (links.length) removeLink(links[0]);
}

/** Knöpfe entfernen, deren Adresse mit prefix beginnt (z. B. „#jarvis-ja“ nach der Antwort). */
export function dropLinks(prefix) {
  const p = String(prefix || "");
  for (const l of links.slice()) if (l.link.url.startsWith(p)) removeLink(l);
}

// ================================================================ Bild (Mac image handler + Bild-Timer)
let imgTimer = 0, imgLeft = 0, imgStart = 0, imgGen = 0, imgOpen = false;
function imgHide() {
  clearTimeout(imgTimer);
  imgTimer = 0; imgLeft = 0; imgOpen = false;
  imgGen += 1;
  body.classList.remove("image-open");
  const box = $("imgview");
  box.className = "";
  box.setAttribute("aria-hidden", "true");
  $("imgview-img").removeAttribute("src");
}
function imgArm(sec) {
  clearTimeout(imgTimer);
  imgLeft = sec * 1000; imgStart = Date.now();
  imgTimer = setTimeout(imgHide, imgLeft);
}

export function showImage({ src, caption } = {}, seconds) {
  if (!src) { imgHide(); return; }
  if (isModelOpen()) hideModel(); // iPhone: immer nur eine Anzeige auf der Bühne
  hideText();
  const box = $("imgview");
  const img = $("imgview-img");
  const my = ++imgGen;
  imgOpen = true;
  img.onload = () => {
    if (my !== imgGen) return;
    const small = img.naturalWidth < 700 && img.naturalHeight < 700;
    box.className = "show" + (small ? " small" : "");
    box.setAttribute("aria-hidden", "false");
    body.classList.add("image-open"); // Bild ohne Kasten, leicht durchsichtig: die Kugel tritt dahinter zurück
  };
  img.onerror = () => { if (my === imgGen) imgHide(); };
  img.alt = String(caption || "");
  img.src = src;
  setText($("imgview-cap"), String(caption || ""));
  imgArm(Number(seconds) > 0 ? Number(seconds) : 7);
}

// solange Jarvis zuhört, läuft die Anzeigezeit nicht (Mac L801-809)
export function pauseImage(on) {
  if (on) {
    if (!imgTimer) return;
    clearTimeout(imgTimer); imgTimer = 0;
    imgLeft -= Date.now() - imgStart;
  } else {
    if (imgTimer || imgLeft <= 0 || !imgOpen) return;
    imgStart = Date.now();
    imgTimer = setTimeout(imgHide, imgLeft);
  }
}

export function hideImage() { imgHide(); }
// Antippen des Bildes schließt es (es liegt über der Kugel, robustness-3)
function bindImage() {
  $("imgview").addEventListener("click", (e) => {
    e.stopPropagation();
    imgHide();
    call("onImageClosed");
  });
}
export function isImageOpen() { return imgOpen; }

// ================================================================ Schwebender Text (Mac #textcard, 13.10. abends)
// „Zeig mir kurz … aus Wikipedia“ (show_text): nur Text, ohne Fläche und Rahmen, über der Kugel; nach 30 s weg,
// „Text weg“ blendet ihn sofort aus. Handy: liegt oben auf der Bühne, die Kugel tritt solange etwas zurück.
// foot: eigene Fußzeile statt „Quelle: …“ (Bestätigungskarten: „Gesendet wird erst nach deinem „ja“.“).
// Passt der Text nicht auf die Bühne (kleines Handy, lange Mail), wird er nie still abgeschnitten: erst Leerzeilen
// weg, dann die Schrift schrittweise kleiner (bis 14 px), zuletzt scrollbar (fitText, auch bei jeder Größenänderung).
let textTimer = 0, textOpen = false, textFull = "";
export function showText({ title = "", text = "", source = "", foot = "", seconds = 30 } = {}) {
  clearTimeout(textTimer);
  const body0 = String(text ?? "").trim();
  if (!body0) { hideText(); return; }
  if (imgOpen) imgHide();
  if (isModelOpen()) hideModel();
  const box = $("textcard");
  textFull = body0.slice(0, 1600);
  setText($("textcard-title"), String(title || "").trim().slice(0, 60));
  setText($("textcard-body"), textFull);
  const f = String(foot || "").trim().slice(0, 80);
  setText($("textcard-src"), f || (String(source || "").trim() ? `Quelle: ${String(source).trim().slice(0, 80)}` : ""));
  box.classList.add("show");
  box.setAttribute("aria-hidden", "false");
  box.scrollTop = 0;
  body.classList.add("text-open");
  textOpen = true;
  fitText();
  const sec = Number(seconds) > 0 ? Math.min(600, Number(seconds)) : 30;
  textTimer = setTimeout(hideText, sec * 1000);
}
function fitText() {
  const box = $("textcard");
  if (!box || !box.classList.contains("show")) return;
  const b = $("textcard-body");
  const fits = () => box.scrollHeight <= box.clientHeight + 1;
  b.style.fontSize = "";
  box.classList.remove("scroll");
  setText(b, textFull);
  if (fits()) return;
  const tight = textFull.replace(/\n[ \t]*\n+/g, "\n");
  if (tight !== textFull) {
    setText(b, tight);
    if (fits()) return;
  }
  const base = Math.floor(parseFloat(getComputedStyle(b).fontSize) || 21);
  for (let px = base - 1; px >= 14; px--) {
    b.style.fontSize = `${px}px`;
    if (fits()) return;
  }
  box.classList.add("scroll");
}
export function hideText() {
  clearTimeout(textTimer);
  textTimer = 0;
  if (!textOpen && !$("textcard").classList.contains("show")) return;
  textOpen = false;
  $("textcard").classList.remove("show");
  $("textcard").setAttribute("aria-hidden", "true");
  body.classList.remove("text-open");
}
export function isTextOpen() { return textOpen; }

// ================================================================ 3D-Modell
export function showModel(spec) {
  if (!window.Model3D) return;
  if (imgOpen) imgHide();
  hideText();
  window.Model3D.show(spec);
  $("model3d").setAttribute("aria-hidden", "false");
}
export function hideModel() {
  if (!window.Model3D) return;
  window.Model3D.hide();
  $("model3d").setAttribute("aria-hidden", "true");
}
export function adjustModel(op) { window.Model3D?.adjust(String(op || "")); }
export function isModelOpen() { return !!window.Model3D?.isOpen(); }

// ================================================================ Kugel greifen, ziehen, aufziehen, zoomen
// Maus wie am Mac (live app.js 13.10. abends): links ziehen = zur Milchstraße langziehen, rechts ziehen = verschieben,
// Alt + ziehen = eine Kugel herausziehen, Mausrad = aufziehen, Strg/Cmd + Rad = Größe, Klick = zuhören/stoppen (nach
// 260 ms, damit ein Doppelklick nicht zuhört), Doppelklick = zurück in die Ursprungsform.
// Finger (Handy-Entscheidung, steht im Hilfe-Blatt): ein Finger ziehen = langziehen/aufziehen, zwei Finger
// auseinander/zusammen = Größe, zwei Finger gemeinsam ziehen = verschieben, lange drücken und ziehen = eine Kugel
// herausziehen, antippen = zuhören/stoppen, zweimal tippen = Ursprungsform. Position und Größe bleiben gespeichert
// (KEYS.orb), Form und Aufzug speichert neuro.js selbst (KEYS.orbForm).
const TAP_WAIT_MS = 260;       // Mac: so lange wartet ein Klick, ob ein Doppelklick daraus wird
const LONG_PRESS_MS = 450;     // Handy: so lange drücken, dann hängt die Kugel unter dem Finger daran
const DRAG_PX = 6;
const TWO_LOCK_PX = 10;        // zwei Finger: ab so viel Bewegung steht fest, ob gezoomt oder verschoben wird
let orbDrag = null, orbDragged = false, orbPos = [0, 0], orbZoomV = 1, zoomSaveTimer = 0;
let tapTimer = 0, pressTimer = 0;
const touches = new Map();
let two = null;                // zwei Finger: { d0, mx, my, lx, ly, z0, ox, oy, mode: null|"pinch"|"move" }

function loadOrb() {
  try {
    const v = JSON.parse(localStorage.getItem(ORB_KEY) || "null");
    if (v && typeof v === "object") {
      orbPos = [Number(v.x) || 0, Number(v.y) || 0];
      orbZoomV = clamp(Number(v.zoom) || 1, 0.5, 2.4);
    }
  } catch { /* egal */ }
  orbPlace(orbPos[0], orbPos[1], false);
  orbScale(orbZoomV, false);
}

function saveOrb() {
  try {
    localStorage.setItem(ORB_KEY, JSON.stringify({ x: Math.round(orbPos[0]), y: Math.round(orbPos[1]), zoom: Math.round(orbZoomV * 1000) / 1000 }));
  } catch { /* egal */ }
}

function orbPlace(x, y, save) {
  const wrap = $("stage-wrap");
  const W = wrap.clientWidth, H = wrap.clientHeight;
  x = Number(x) || 0; y = Number(y) || 0;
  if (W && H) { // Mitte der Kugel bleibt auf der Bühne (Handy: nicht über Panels oder Eingabezeile)
    const mx = Math.max(0, W / 2 - 24), my = Math.max(0, H / 2 - 24);
    x = clamp(x, -mx, mx); y = clamp(y, -my, my);
  }
  if (save && Math.hypot(x, y) < 50) { x = 0; y = 0; } // nah an der Mitte: einrasten
  orbPos = [x, y];
  $("stage").style.translate = x || y ? `${Math.round(x)}px ${Math.round(y)}px` : "";
  if (save) saveOrb();
}

function orbScale(z, save) {
  orbZoomV = clamp(Number(z) || 1, 0.5, 2.4);
  $("stage").style.scale = Math.abs(orbZoomV - 1) < 0.01 ? "" : String(Math.round(orbZoomV * 1000) / 1000);
  if (save) saveOrb();
}

function saveZoomSoon() {
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(() => orbScale(orbZoomV, true), 400);
}

export function orbReset() { orbPlace(0, 0, true); }

export function orbZoom(op) {
  const z = op === "normal" || op === "reset" ? 1 : orbZoomV * (op === "smaller" ? 0.8 : op === "bigger" ? 1.25 : 1);
  orbScale(z, true);
}

/** „Zeig dein Gehirn als Galaxie“: Form wechseln (ringe, kern, galaxie, netz, schalen); gibt die Form zurück. */
export function orbShape(name) {
  if (!orb?.setShape) return "";
  return orb.setShape(String(name || "ringe"));
}

/** Doppeltippen / „Form zurück“: Langziehen und Aufziehen zurücksetzen (Mac resetForm). */
export function orbResetForm() { orb?.resetForm?.(); }

/** Zustand der Kugel (Tests, Anzeige): Form, Aufzug, Position, Größe. */
export function orbState() {
  return { shape: orb?.shape || "", open: orb?.openAmount ? Math.round(orb.openAmount() * 1000) / 1000 : 0,
    openNow: Math.round((orb?.openNow || 0) * 1000) / 1000, sk: orb?.sk ?? 1, spread: orb?.spread ?? 1,
    x: Math.round(orbPos[0]), y: Math.round(orbPos[1]), zoom: Math.round(orbZoomV * 1000) / 1000 };
}

// Punkt auf dem Bildschirm → Pixel im Kugel-Canvas (die Bühne ist skaliert, verschoben und gezoomt)
function orbPoint(e) {
  const c = $("orb"), r = c.getBoundingClientRect();
  return [(e.clientX - r.left) * (c.width / (r.width || 1)), (e.clientY - r.top) * (c.height / (r.height || 1))];
}

function twoFingers() {
  const [a, b] = [...touches.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

// Unten auf der Bühne steht die Telemetrie (KI.KERN / LETZTE ANTWORT): die Kugel samt Zustandsschrift („HÖRE ZU“)
// bekommt nur den Platz darüber, sonst liegen beide übereinander, sobald die Bühne niedriger als breit ist (visual-ux-1).
// Die Höhe kommt aus der Telemetrie selbst (am Handy ist sie seit dem Verkleinern niedriger als am Rechner).
const TELEMETRY_BAND = 36;
function sizeStage() {
  const wrap = $("stage-wrap");
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  const tm = document.querySelector(".telemetry .tm.t3");
  const tmH = tm && tm.offsetHeight ? Math.ceil(tm.offsetHeight) + 2 : TELEMETRY_BAND;
  const band = body.classList.contains("focus") ? 0 : tmH;
  const s = Math.max(60, Math.floor(Math.min(W, H - band)));
  const st = $("stage");
  if (st.style.width !== `${s}px` || st.dataset.band !== String(band)) {
    Object.assign(st.style, { width: `${s}px`, height: `${s}px`, margin: `${-s / 2}px 0 0 ${-s / 2}px`,
      top: band ? `calc(50% - ${band / 2}px)` : "" });
    st.dataset.band = String(band);
  }
  orb?.resize?.();
  orbPlace(orbPos[0], orbPos[1], false);
  fitPlaceholder();
}

// Ein Finger / eine Maustaste endet (oder ein zweiter Finger kommt dazu): Kugel loslassen, Aufzug speichern
function endOne(save = true) {
  clearTimeout(pressTimer);
  if (!orbDrag) return;
  const d = orbDrag;
  orbDrag = null;
  const wasNode = d.node >= 0;
  if (wasNode) orb?.release();
  orb?.grab(false);
  $("stage").classList.remove("grabbing");
  if (!save || !orbDragged || wasNode) return;
  if (d.move) orbPlace(orbPos[0], orbPos[1], true);
  else orb?.stretchSave?.();
}

// Handy: lange gedrückt, ohne zu ziehen → die Kugel unter dem Finger hängt daran
function longPress() {
  pressTimer = 0;
  const d = orbDrag;
  if (!d || d.mouse || orbDragged || d.node >= 0 || touches.size !== 1 || !orb) return;
  const c = $("orb"), r = c.getBoundingClientRect();
  const node = orb.pick(d.cx, d.cy, 16 * (c.width / (r.width || 1)));
  if (node < 0) return;
  d.node = node;
  orbDragged = true; // kein Antippen mehr
  orb.grab(true);
  orb.pull(node, d.cx, d.cy);
  $("stage").classList.add("grabbing");
  try { navigator.vibrate?.(12); } catch { /* egal */ }
}

function orbClickTap(e) {
  if (orbDragged) { orbDragged = false; return; } // war ein Ziehen, kein Antippen
  if (e.detail >= 2 || tapTimer) { // Doppelklick / zweimal tippen: zurück in die Ursprungsform, nicht zuhören
    clearTimeout(tapTimer);
    tapTimer = 0;
    orbResetForm();
    return;
  }
  // Tastatur (Enter auf der Kugel) oder ein Tippen, das sofort im Finger laufen muss (Tastatur öffnen): ohne Warten
  if (e.detail === 0 || call("orbTapNow") === true) { call("onOrbTap"); return; }
  tapTimer = setTimeout(() => { tapTimer = 0; call("onOrbTap"); }, TAP_WAIT_MS);
}

function bindStage() {
  const stage = $("stage");
  stage.addEventListener("contextmenu", (e) => e.preventDefault()); // rechts ziehen = verschieben (Mac)
  stage.addEventListener("pointerdown", (e) => {
    const mouse = e.pointerType === "mouse";
    if (mouse && e.button !== 0 && e.button !== 2) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch { /* egal */ }
    if (!mouse && touches.size === 2) { // zweiter Finger: zoomen oder verschieben statt langziehen
      endOne(true);
      orbDragged = true; // kein Antippen
      const f = twoFingers();
      two = { d0: f.d, mx: f.mx, my: f.my, lx: f.mx, ly: f.my, z0: orbZoomV, ox: orbPos[0], oy: orbPos[1], mode: null };
      stage.classList.add("grabbing");
      return;
    }
    if (touches.size > 1 || two) return;
    const [cx, cy] = orbPoint(e);
    const node = mouse && e.altKey && orb ? orb.pick(cx, cy) : -1; // Alt + ziehen: eine Kugel herausziehen
    orbDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, ox: orbPos[0], oy: orbPos[1],
      node, move: mouse && e.button === 2, mouse, cx, cy, st: orb?.stretchState ? orb.stretchState() : null };
    orbDragged = false;
    clearTimeout(pressTimer);
    if (!mouse) pressTimer = setTimeout(longPress, LONG_PRESS_MS);
  });
  stage.addEventListener("pointermove", (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (two) {
      if (touches.size < 2) return;
      const f = twoFingers();
      const ds = Math.abs(f.d - two.d0), dm = Math.hypot(f.mx - two.mx, f.my - two.my);
      if (!two.mode && Math.max(ds, dm) > TWO_LOCK_PX) {
        two.mode = ds >= dm ? "pinch" : "move";
        if (two.mode === "move") orb?.grab(true);
      }
      if (two.mode === "pinch") {
        orbScale(two.z0 * (f.d / two.d0), false);
        saveZoomSoon();
      } else if (two.mode === "move") {
        orb?.nudge((f.mx - two.lx) * 0.006, (f.my - two.ly) * 0.006);
        two.lx = f.mx; two.ly = f.my;
        orbPlace(two.ox + f.mx - two.mx, two.oy + f.my - two.my, false);
      }
      return;
    }
    if (!orbDrag || orbDrag.id !== e.pointerId) return;
    const dx = e.clientX - orbDrag.x, dy = e.clientY - orbDrag.y;
    orbDrag.x = e.clientX; orbDrag.y = e.clientY;
    if (!orbDragged && Math.hypot(e.clientX - orbDrag.sx, e.clientY - orbDrag.sy) > DRAG_PX) {
      orbDragged = true;
      clearTimeout(pressTimer);
      orb?.grab(true);
      stage.classList.add("grabbing");
    }
    if (!orbDragged) return;
    if (orbDrag.node >= 0) { orb?.pull(orbDrag.node, ...orbPoint(e)); return; } // Kugel herausziehen, Netz federt
    if (!orbDrag.move) { // langziehen/aufziehen: Richtung und Weite vom Startpunkt aus
      orb?.stretchTo?.(e.clientX - orbDrag.sx, e.clientY - orbDrag.sy, orbDrag.st);
      return;
    }
    orb?.nudge(dx * 0.006, dy * 0.006);
    orbPlace(orbDrag.ox + e.clientX - orbDrag.sx, orbDrag.oy + e.clientY - orbDrag.sy, false);
  });
  const release = (e) => {
    touches.delete(e.pointerId);
    try { stage.releasePointerCapture(e.pointerId); } catch { /* egal */ }
    if (two) {
      if (touches.size < 2) {
        if (two.mode === "move") { orb?.grab(false); orbPlace(orbPos[0], orbPos[1], true); }
        if (two.mode === "pinch") orbScale(orbZoomV, true);
        two = null;
        stage.classList.remove("grabbing");
      }
      return;
    }
    if (!orbDrag || orbDrag.id !== e.pointerId) return;
    endOne(true);
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  stage.addEventListener("lostpointercapture", (e) => { if (touches.has(e.pointerId)) release(e); });
  stage.addEventListener("wheel", (e) => { // Maus/Trackpad wie am Mac
    e.preventDefault();
    if (!(e.ctrlKey || e.metaKey) && orb?.unfold) { orb.unfold(Math.exp(-e.deltaY * 0.0012)); return; } // Rad: aufziehen
    orbScale(orbZoomV * Math.exp(-e.deltaY * 0.001), false); // Strg/Cmd + Rad (und Zwei-Finger-Zoom am Trackpad): Größe
    saveZoomSoon();
  }, { passive: false });
  stage.addEventListener("click", orbClickTap);
}

// ================================================================ Bedienung
function bindControls() {
  $("app").addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-cmd]");
    if (!btn || !$("app").contains(btn)) return;
    call("onCommand", btn.dataset.cmd, btn);
  });
  $("timers").addEventListener("click", (e) => {
    const row = e.target.closest?.(".timer[data-id]");
    if (!row) return;
    call("onTimerCancel", row.dataset.id);
    toast("Timer gelöscht.");
  });
  const input = $("ask-input");
  $("ask-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.blur();
    call("onSubmit", text);
  });
  input.addEventListener("focus", () => { call("onInputFocus", true); updateKeyboard(); });
  input.addEventListener("blur", () => { call("onInputFocus", false); setTimeout(updateKeyboard, 0); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (document.querySelector(".sheet:not([hidden])")) return; // Blätter schließt sheets.js
    call("onCommand", "stop", null);
    input.blur();
  });
  $("unlock").addEventListener("click", () => call("onUnlockTap"));
  $("unlock").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); call("onUnlockTap"); }
  });
}

// ================================================================ Panels zum Wischen
const pageEls = () => [...$("deck-track").children];
const dotButtons = () => [...$("dots").children];
let deckSettle = 0;

function stride() {
  const p = pageEls();
  return p.length > 1 ? p[1].offsetLeft - p[0].offsetLeft : $("deck").clientWidth;
}

function markPage(i) {
  dotButtons().forEach((b, k) => {
    b.classList.toggle("active", k === i);
    b.setAttribute("aria-current", k === i ? "true" : "false");
  });
  if (i === LOG_PAGE) {
    dotButtons()[LOG_PAGE]?.classList.remove("badge");
    logToEnd();
  }
  if (i === SYSTEM_PAGE) { updateGauges(); drawDiag(); }
  if (i === KONTO_PAGE && hasMoney(kontoData)) { drawKontoCanvases(); if (started) wakeMarkets(); }
}

function alignDeck() {
  const s = stride();
  if (s > 0) $("deck").scrollLeft = page * s;
}

function bindDeck() {
  const deck = $("deck");
  const logBox = $("log");
  logBox.addEventListener("scroll", () => {                 // hochgescrollt: nicht mehr ans Ende springen
    if (logBox.clientHeight) logStick = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 24;
  }, { passive: true });
  deck.addEventListener("scroll", updateMore, { passive: true });
  for (const p of pageEls()) p.addEventListener("scroll", updateMore, { passive: true });
  deck.addEventListener("scroll", () => {
    const s = stride();
    if (s <= 0) return;
    const i = clamp(Math.round(deck.scrollLeft / s), 0, PAGES.length - 1);
    if (i !== page) { page = i; markPage(i); }
    clearTimeout(deckSettle);
    deckSettle = setTimeout(() => {
      if (lastReported !== page) { lastReported = page; call("onDeckPage", page); }
    }, 140);
  }, { passive: true });
  dotButtons().forEach((b, i) => b.addEventListener("click", () => {
    const changed = lastReported !== i;
    goToPage(i);
    if (changed) call("onDeckPage", i);
  }));
}

export function goToPage(name, smooth = true) {
  const i = typeof name === "number" ? name : PAGES.indexOf(String(name));
  if (!Number.isInteger(i) || i < 0 || i >= PAGES.length) return;
  page = i;
  lastReported = i;
  markPage(i);
  const s = stride();
  if (s <= 0) return;
  const deck = $("deck");
  if (smooth && !reduced && typeof deck.scrollTo === "function") deck.scrollTo({ left: i * s, behavior: "smooth" });
  else deck.scrollLeft = i * s;
}

// ================================================================ Hinweis, Fokus, Abdunkeln, Wake-Knopf
let toastTimer = 0;
// Hinweis über der Eingabezeile und über den Link-Knöpfen (die je nach Tastatur/Layout woanders stehen). Solange er
// steht, blenden Zustandsschrift und Telemetrie unter der Kugel aus (body.toast-on): nichts überlappt.
function placeToast(force = false) {
  const t = $("toast");
  if (!force && !t.classList.contains("show")) return;
  const sheetOpen = !!document.querySelector(".sheet:not([hidden])");
  const cmd = $("ask-form").getBoundingClientRect();
  const bar = $("actionbar").getBoundingClientRect();          // Link-Knöpfe nicht verdecken
  const top = bar.height ? Math.min(cmd.top, bar.top) : cmd.top;
  if (sheetOpen || !cmd.height || root.classList.contains("is-hidden")) {
    // über einem Blatt unten mittig, über „Speichern“ (visual-ux-5)
    t.style.bottom = sheetOpen ? "calc(var(--safe-b) + 76px)" : "";
    t.style.left = "";
    return;
  }
  t.style.bottom = `${Math.max(8, window.innerHeight - top + 8)}px`;
  // waagrecht über der Eingabezeile (Handy quer, Rechner: die steht nicht in der Bildschirmmitte)
  t.style.left = `${Math.round(cmd.left + cmd.width / 2)}px`;
}

/** Hinweis sofort weg (ein Blatt geht auf). */
export function hideToast() {
  const t = $("toast");
  clearTimeout(toastTimer);
  t.classList.remove("show");
  body.classList.remove("toast-on");
}

export function toast(text, ms = 2500) {
  const t = $("toast");
  setText(t, String(text || ""));
  body.classList.add("toast-on");
  placeToast(true);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    body.classList.remove("toast-on");
  }, Math.max(800, Number(ms) || 2500));
}

export function setFocus(on) {
  body.classList.toggle("focus", !!on);
  relayout();
  const b = $("focus-btn");
  b.classList.toggle("on", !!on);
  setText(b, on ? "◆ Alle Panels" : "◇ Nur Kugel");
  b.setAttribute("aria-pressed", on ? "true" : "false");
  requestAnimationFrame(sizeStage);
}

export function setDim(on) { body.classList.toggle("dim", !!on); }

export function setWakeButton(on) {
  const b = $("wake-btn");
  setText(b, on ? "◎ Wake-Word an" : "◌ Wake-Word aus");
  b.classList.toggle("on", !!on);
  b.classList.toggle("off", !on);
  b.setAttribute("aria-pressed", on ? "true" : "false");
}

// ================================================================ Ausblenden / Einblenden (§9.4)
let popTimer = 0;
let veilFlash = 0;
let veilTapAt = 0;

export function setVisibility(mode, { fast = false, pop = false, hint = "" } = {}) {
  const veil = $("veil");
  if (mode === "hidden" || mode === "stealth") {
    if (hint) setText($("veil-hint"), hint);
    // frisch ausgeblendet: der Weg zurück ist ein paar Sekunden gut lesbar, dann wieder dunkel (Einbrennschutz)
    if (!root.classList.contains("is-hidden")) flashVeilHint(4000);
    veil.style.transition = fast ? "none" : "";
    $("app").style.transition = fast ? "none" : "";
    body.classList.remove("popin");
    root.classList.add("is-hidden");
    root.classList.toggle("is-stealth", mode === "stealth");
    veil.setAttribute("aria-hidden", "false");
    if (document.activeElement === $("ask-input")) $("ask-input").blur();
    setPaused(true);
    return;
  }
  veil.style.transition = "";
  $("app").style.transition = "";
  root.classList.remove("is-hidden", "is-stealth");
  veil.setAttribute("aria-hidden", "true");
  setPaused(false);
  relayout();
  if (pop) {
    clearTimeout(popTimer);
    body.classList.remove("popin");
    void body.offsetWidth; // Animation neu starten
    body.classList.add("popin");
    popTimer = setTimeout(() => body.classList.remove("popin"), 300);
  }
}

// Overlay aus- bzw. eingeblendet: Animationen anhalten bzw. fortsetzen (Mac setPaused)
export function setPaused(on) {
  paused = !!on;
  root.classList.toggle("paused", paused);
  orb?.pause(paused || !started);
  // Das 3D-Modell bleibt: kurz in eine andere App und zurück soll es nicht wegnehmen (robustness-10). Ausblenden und
  // Hintergrund (enterHidden/enterStealth in app.js) schließen es selbst; im Hintergrund-Tab drosselt der Browser.
  window.Galaxy?.pause(paused);
  if (!paused) { // wieder sichtbar: sofort alles auf den aktuellen Stand bringen
    lastMinute = -1;
    tick();
    renderTicker();
    drawDiag();
    if (kontoData) drawKontoCanvases();
    wakeMarkets();
    ping();
  }
}

function bindVeil() {
  const veil = $("veil");
  veil.addEventListener("click", () => {
    const now = Date.now();
    if (now - veilTapAt < 400) { // zweimal auf Schwarz: zurück
      veilTapAt = 0;
      call("onVeilDoubleTap");
      return;
    }
    veilTapAt = now;
    flashVeilHint(2000); // einmal: Hinweis kurz heller
  });
}

function flashVeilHint(ms) {
  const h = $("veil-hint");
  h.style.opacity = "0.6";
  clearTimeout(veilFlash);
  veilFlash = setTimeout(() => { h.style.opacity = ""; }, ms);
}

// Einbrennschutz: Hinweis jede Minute ein paar Pixel verschieben
function nudgeVeilHint() {
  if (!root.classList.contains("is-hidden")) return;
  const r = () => Math.round(Math.random() * 16 - 8);
  $("veil-hint").style.translate = `${r()}px ${r()}px`;
}

// ================================================================ Startbildschirm, Freischalten
let bootGen = 0;
export function showBoot(line) {
  const boot = $("boot");
  const my = ++bootGen;
  if (line == null) {
    if (boot.hidden) return;
    boot.classList.add("gone");
    setTimeout(() => { if (my === bootGen) { boot.hidden = true; boot.classList.remove("gone"); } }, 800);
    return;
  }
  setText($("boot-line"), String(line));
  boot.classList.remove("gone");
  boot.hidden = false;
}

let unlockHideTimer = 0;
export function showUnlock(text) {
  const u = $("unlock");
  if (text == null) {
    if (u.hidden) return;
    // Erst unsichtbar, ein paar hundert ms später weg: der Klick, den der Browser nach dem Tippen nachschiebt, landet
    // noch auf dem Fänger und nicht auf der Kugel darunter (die würde sonst „Ja, Boss?“ gleich wieder abbrechen)
    u.classList.add("closing");
    body.classList.remove("locked");
    clearTimeout(unlockHideTimer);
    unlockHideTimer = setTimeout(() => { u.hidden = true; u.classList.remove("closing"); }, 450);
    return;
  }
  clearTimeout(unlockHideTimer);
  u.classList.remove("closing");
  setText($("unlock-text"), String(text));
  const r = $("stage").getBoundingClientRect(); // über der Kugel
  if (r.height) u.style.setProperty("--unlock-y", `${Math.round(r.top + r.height / 2)}px`);
  u.hidden = false;
  body.classList.add("locked");
  try { u.focus({ preventScroll: true }); } catch { /* ignore */ } // Tastatur: Enter/Leertaste startet auch
}

export function isUnlockShown() { return !$("unlock").hidden && !$("unlock").classList.contains("closing"); }

export function focusInput() {
  const input = $("ask-input");
  input.focus();
  updateKeyboard();
}

// ================================================================ Tastatur (Bug 42)
const coarse = window.matchMedia?.("(pointer: coarse)");
function updateKeyboard() {
  const vv = window.visualViewport;
  const focused = document.activeElement === $("ask-input");
  let kb = 0;
  if (vv) kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  const open = focused && (kb > 60 || !!coarse?.matches);
  root.style.setProperty("--kb", open && kb > 60 ? `${kb}px` : "0px");
  const was = body.classList.contains("kb-open");
  body.classList.toggle("kb-open", open);
  if (open && window.scrollY) window.scrollTo(0, 0); // iOS schiebt die Seite sonst unter die Tastatur
  if (was !== open) relayout();
}

function bindKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  vv.addEventListener("resize", updateKeyboard);
  vv.addEventListener("scroll", updateKeyboard);
}

// ================================================================ Weniger Bewegung (§9.5)
export function setReducedMotion(on) {
  reduced = !!on;
  root.classList.toggle("reduced", reduced);
  orb?.setReducedMotion?.(reduced);
  window.Galaxy?.setReducedMotion?.(reduced);
}
