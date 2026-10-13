// ==============================================================================================================
// CONTRACT – tools.js (owner: builder BRAIN). Spec: ARCHITECTURE.md §3.2.3, §3.5.3, §6.4, §6.5, §7.6, §7.7.
// Executes AKTION payloads and quick-intent actions on the phone: validation/aliases, links that need a tap
// (YouTube, Spotify, Google, Apple Maps on Apple devices / Google Maps elsewhere, tel:, wa.me, Amazon), weather
// (open-meteo), Wikipedia images, 3D models
// (Mac model_spec) and orb commands as UI results, timers / notes / shortcuts / konto / termine / settings via
// store.js, learn guard. Mac-only types answer honestly. Imports: store.js, intents.js. No DOM. runAction() never throws.
// ==============================================================================================================

import * as store from "./store.js";
import * as intents from "./intents.js";

/** @typedef {{ type: string, [field: string]: any }} Action */
/** @typedef {{ url: string, label: string, icon: string }} Link  icon: "↗"|"▶"|"♫"|"⌖"|"☎"|"✉"|"🛒" */
/**
 * @typedef {Object} ActionResult
 * @property {string} type
 * @property {boolean} ok
 * @property {string} [say]
 * @property {Link} [link]
 * @property {{ src: string, caption: string }} [image]
 * @property {"stealth"|"hide"|"show"|"hide_image"} [ui]
 * @property {{ id: string, label: string, ends: number, created: number, seconds: number }} [timer]
 * @property {{ kind: string, text: string }} [log]
 * @property {object|null} [model]  show_model → ModelSpec, hide_model → null (hud.showModel / hud.hideModel)
 * @property {string} [modelOp]     model_adjust op (hud.adjustModel)
 * @property {{ op: "reset"|"bigger"|"smaller"|"normal" }} [orb]  orb_reset / orb_zoom (hud.orbReset / hud.orbZoom)
 * @property {boolean} [macOnly]
 * @property {boolean} [blocked]   true when refused by the SAFE_AFTER_WEB guard (D15) or the learn guard (D18)
 */
/**
 * @typedef {Object} ActionContext
 * @property {Date} now
 * @property {AbortSignal} [signal]   a stopped turn aborts all network calls
 * @property {string} anrede
 * @property {string} wohnort
 * @property {string} said            the user's own words of this turn (learn guard)
 * @property {boolean} webUsed        this answer used web search → only SAFE_AFTER_WEB may run
 * @property {boolean} webSeen        any answer of this conversation used web search → no LEARN_ACTIONS
 * @property {boolean} fromClaude
 */

/** Actions whose result is a Link the user taps (iOS needs a gesture to leave the app). */
export const LINK_ACTIONS = Object.freeze(new Set([
  "open_url", "web_search", "youtube", "spotify", "maps", "route", "amazon", "call", "whatsapp",
]));

/** Every action type the phone executes (§6.4.3). */
export const PHONE_ACTIONS = Object.freeze(new Set([
  ...LINK_ACTIONS,
  "timer", "timer_stop", "weather", "show_image", "next_image", "hide_image",
  "show_model", "hide_model", "model_adjust", "orb_reset", "orb_zoom",
  "remember", "forget_note", "learn_command", "forget_command", "hide_jarvis",
  "einnahme", "kontostand", "termin", "termin_loeschen", "set_setting",
]));

/** Learn actions (live Mac LEARN_ACTIONS minus teach_jarvis): need LEARN_SIGNAL in the user's words and no web (D18). */
export const LEARN_ACTIONS = Object.freeze(new Set([
  "remember", "forget_note", "learn_command", "forget_command", "set_setting",
]));

/** Mac-only action type → intents.LINES key of the honest answer (§6.4.4). Other spotify.cmd → "media". */
export const MAC_ONLY = Object.freeze(new Map([
  ["open_app", "macOnly"], ["open_folder", "macOnly"], ["peek", "macOnly"], ["tiktok_mode", "macOnly"],
  ["tiktok_cmd", "macOnly"], ["image_default", "macOnly"], ["image_adjust", "macOnly"], ["image_chrome", "macOnly"],
  ["calendar_change", "macOnly"], ["calendar_apply", "macOnly"],
  ["quit_app", "macOnlyApps"], ["hotspot", "macOnlyHotspot"],
  ["teach_jarvis", "macOnlyTeach"], ["claude_build", "macOnlyTeach"],
  ["media", "macOnlyMusic"], ["volume", "macOnlyMusic"],
  ["whatsapp_unread", "macOnlyWhatsApp"],
  ["mail_reply", "macOnlyMail"],
]));

/** Allowed in an answer that used web search (§6.5, D15); links still need a tap. */
export const SAFE_AFTER_WEB = Object.freeze(new Set([
  "timer", "timer_stop", "weather", "show_image", "next_image", "hide_image", "open_url", "web_search", "youtube",
  "spotify", "maps", "route", "amazon", "hide_jarvis", "show_model", "hide_model", "model_adjust", "orb_reset",
  "orb_zoom",
]));

/** Not allowed inside a stealth combo (§6.5; links, pictures and models need the visible overlay). */
export const NOT_IN_STEALTH = Object.freeze(new Set([
  "show_image", "next_image", "weather", "show_model", "model_adjust", ...LINK_ACTIONS,
]));

/**
 * Voice-changeable settings (§6.4.5, Mac SETTINGS jarvis.py L1630-1640): Mac key (as Claude emits it) → store key,
 * type, range, German description for the settingRange line. Mac-only keys (peek_seconds, tiktok_min_conf) are
 * absent → settingUnknown.
 */
export const SETTING_KEYS = Object.freeze({
  image_seconds: Object.freeze({ key: "imageSeconds", type: "int", min: 3, max: 120, what: "wie lange ein Bild bleibt (Sekunden)" }),
  silence_seconds: Object.freeze({ key: "silenceSeconds", type: "float", min: 0.6, max: 4.0, what: "Sprechpause, bis Jarvis antwortet (Sekunden)" }),
  hesitation_seconds: Object.freeze({ key: "hesitationSeconds", type: "float", min: 1.0, max: 5.0, what: "Pause nach „äh“/„und“ (Sekunden)" }),
  max_record_seconds: Object.freeze({ key: "maxRecordSeconds", type: "int", min: 10, max: 90, what: "wie lange du am Stück reden darfst (Sekunden)" }),
  speak_max_sentences: Object.freeze({ key: "speakMaxSentences", type: "int", min: 1, max: 8, what: "wie viele Sätze Jarvis vorliest" }),
  home_city: Object.freeze({ key: "wohnort", type: "str", min: 2, max: 60, what: "Ort für das Wetter" }),
  closing_phrase: Object.freeze({ key: "closingPhrase", type: "str", min: 0, max: 80, what: "Frage nach einem Befehl (leer = keine)" }),
  voice_speed: Object.freeze({ key: "voiceSpeed", type: "int", min: -30, max: 50, what: "Tempo der Stimme in Prozent" }),
});

// ---------------------------------------------------------------- private: intents access (contract §3.2.4)

// Reference ure() of §3.2.4, used only if intents.js does not provide it (keeps this module loadable).
const WC = "\\p{L}\\p{N}_";
const UB = `(?:(?<=[${WC}])(?![${WC}])|(?<![${WC}])(?=[${WC}]))`;
const SYNTAX = new Set([..."^$\\.*+?()[]{}|/"]);
const KEEP = new Set([..."bBdDsSwWnrtfv0123456789uxcpPk"]);
function refUre(src, flags = "") {
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[++i];
      if (n === "b" && !inClass) out += UB;
      else if (n === "w") out += inClass ? WC : `[${WC}]`;
      else if (n === "W" && !inClass) out += `[^${WC}]`;
      else if (KEEP.has(n) || SYNTAX.has(n) || (inClass && n === "-")) out += "\\" + n;
      else out += n;
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  if (out.startsWith("(?i)")) {
    out = out.slice(4);
    if (!flags.includes("i")) flags += "i";
  }
  return new RegExp(out, flags.includes("u") ? flags : flags + "u");
}
const ure = typeof intents.ure === "function" ? intents.ure : refUre;
const WEEKDAYS = Array.isArray(intents.WEEKDAYS) && intents.WEEKDAYS.length === 7 ? intents.WEEKDAYS
  : ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

/** §5.2 texts, used only when intents.line() is unavailable or cannot fill a key. */
const FALLBACK_LINES = {
  // wie intents.js LINES: kein Verweis auf einen Mac-Jarvis, den Besucher nicht haben (visual-ux-6)
  macOnly: "Das kann ich hier nicht, {A}.",
  macOnlyMusic: "Das kann ich hier nicht, {A}. Ton und Musik regelst du am Gerät selbst.",
  macOnlyWhatsApp: "WhatsApp vorlesen kann ich hier nicht, {A}.",
  macOnlyMail: "Deine Mails kann ich hier nicht lesen, {A}.",
  macOnlyApps: "Programme schließen kann ich hier nicht, {A}.",
  macOnlyHotspot: "Den Hotspot kann ich hier nicht verbinden, {A}.",
  macOnlyTeach: "Neue Fähigkeiten kann ich mir hier nicht selbst beibringen, {A}.",
  actionFailed: "Das hat leider nicht geklappt.",
  weatherNoData: "Ich komme gerade nicht an die Wetterdaten.",
  weatherNoPlace: "Den Ort {place} finde ich nicht.",
  weatherNoHome: "Für das Wetter brauche ich deinen Wohnort, {A}. Trag ihn bitte in den Einstellungen ein.",
  imageNone: "Ich finde gerade kein Bild von {query}.",
  imageNoMore: "Ich finde kein weiteres Bild von {query}.",
  imageNoneYet: "Ich hab dir noch kein Bild gezeigt.",
  learnFail: "Den Kurzbefehl kann ich so nicht anlernen.",
  forgetUnknown: "Einen Kurzbefehl „{phrase}“ kenne ich nicht.",
  learnOnlyOwn: "Das lerne ich nur, wenn du es mir selbst sagst.",
  timerStopped: "Okay, {A}, Timer gestoppt.",
  noTimer: "Es läuft gerade kein Timer.",
  settingUnknown: "Das kann ich bei mir nicht einstellen.",
  settingRange: "Für {what} geht nur {lo} bis {hi}.",
  settingValue: "Den Wert verstehe ich nicht.",
  kontoValue: "Den Betrag verstehe ich nicht, {A}.",
  terminValue: "Den Termin verstehe ich nicht, {A}. Sag mir Tag und Uhrzeit.",
  terminNone: "Diesen Termin finde ich nicht in deiner Liste.",
  callNoNumber: "Dafür brauche ich eine Telefonnummer, {A}.",
  waReady: "Steht bereit für {to}. Tipp auf WhatsApp und dann auf Senden.",
  waReadyNoTo: "Die Nachricht steht bereit. Tipp auf WhatsApp und wähl den Chat.",
};

function fill(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

/** Spoken line: intents.line(key, vars) with {A} = Anrede; local §5.2 text when that is not available. */
function say(key, vars = {}, anrede = "") {
  const A = String(anrede || vars.A || "").trim() || safeAnrede();
  const v = { ...vars, A, anrede: A };
  if (key !== "waReadyNoTo") {
    try {
      const s = typeof intents.line === "function" ? intents.line(key, v) : "";
      if (typeof s === "string" && s && s !== key && !/\{\w+\}/.test(s)) return s;
    } catch { /* fall back below */ }
  }
  return fill(FALLBACK_LINES[key] ?? "", v);
}

function safeAnrede() {
  try { return store.anrede(); } catch { return "Boss"; }
}

function sayDuration(seconds) {
  if (typeof intents.sayDuration === "function") {
    try { return intents.sayDuration(seconds); } catch { /* local port below */ }
  }
  const total = Math.trunc(Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h} Stunde` + (h > 1 ? "n" : ""));
  if (m) parts.push(`${m} Minute` + (m > 1 ? "n" : ""));
  if (s && !h) parts.push(`${s} Sekunde` + (s > 1 ? "n" : ""));
  return parts.join(" und ") || "0 Sekunden";
}

// ---------------------------------------------------------------- private: small helpers

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v, max = 200) => (v === undefined || v === null ? "" : String(v)).replace(/\s+/g, " ").trim().slice(0, max);

/** Mac nice(): words longer than 2 letters capitalised, short ones upper case. */
function nice(name) {
  return String(name ?? "").split(/\s+/).filter(Boolean)
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toUpperCase())).join(" ");
}

/** Python round(): half to even. */
function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Python float(v): numbers, bools, numeric strings (incl. inf/nan); anything else throws. */
function pyFloat(v) {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
    if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(s)) return NaN;
  }
  throw new TypeError("float");
}

/** Amount from a number or „1.200,50“ / „2,5“ / „20 €“. NaN when not understood. */
function parseAmount(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v !== "string") return NaN;
  let s = v.replace(/[€$\s]|eur(o)?|usd/gi, "");
  if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}

function money(n) {
  let cur = "EUR";
  try { cur = store.konto()?.waehrung === "USD" ? "USD" : "EUR"; } catch { cur = "EUR"; }
  try {
    return Number(n).toLocaleString("de-DE", { style: "currency", currency: cur,
      minimumFractionDigits: cur === "USD" ? 0 : 2, maximumFractionDigits: cur === "USD" ? 0 : 2 });
  } catch {
    return `${n} ${cur === "USD" ? "$" : "€"}`;
  }
}

/** AbortSignal that fires on the outer signal or after ms (setTimeout, so tests can fast-forward). */
function timed(signal, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException("timeout", "TimeoutError")), ms);
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const done = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  };
  return { signal: ctl.signal, done };
}

async function getJSON(url, signal, ms = 6000) {
  const t = timed(signal, ms);
  try {
    const res = await fetch(url, { signal: t.signal, headers: { Accept: "application/json" } });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    t.done();
  }
}

const isAbort = (e, signal) => !!signal?.aborted || e?.name === "AbortError";

// ---------------------------------------------------------------- 3D models (live jarvis.py L1763-1952)

const MODEL_SHAPES = new Set(["cube", "box", "sphere", "globe", "cylinder", "cone", "pyramid", "prism", "tetrahedron",
  "octahedron", "dodecahedron", "icosahedron", "torus", "helix", "dna", "atom", "hypercube", "simplex", "surface",
  "orthoplex", "cell24", "hypersphere", "clifford", "nd"]);
const MODEL_PARTS = new Set(["box", "sphere", "cylinder", "cone", "pyramid", "prism", "torus", "line", "tetrahedron",
  "octahedron", "icosahedron", "dodecahedron"]);
const MODEL_OPS = new Set(["bigger", "smaller", "faster", "slower", "stop", "spin", "left", "right", "up", "down", "reset"]);
const FORMULA_RX = ure("^(?:[0-9a-z+\\-*/^()., ²³=·×]+)$");
const COLOR_RX = ure("^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))$");

/**
 * Pure port of the Mac model_spec (live jarvis.py L1858-1952): only allowed fields in safe ranges
 * (shape ∈ MODEL_SHAPES, dims 4..7, formula ≤ 120 chars of [0-9a-z+-*\/^()., ²³=·×], range 0.1..50, #rgb colours,
 * title ≤ 40, ≤ 80 parts with clamped pos/size/rot/r/h/tube/sides/width, nd vertices ≤ 256 / edges ≤ 1000;
 * nothing usable → { shape: "cube" }).
 * @param {object} raw show_model action
 * @returns {object} ModelSpec
 */
export function modelSpec(raw) {
  const a = isObj(raw) ? raw : {};
  const nums = (v, n = 3) => {
    if (!Array.isArray(v)) return null;
    return v.slice(0, n).map((x) => {
      let f;
      try { f = pyFloat(x); } catch { f = 0; }
      return Number.isNaN(f) ? 0 : Math.max(-50, Math.min(50, f));
    });
  };
  const number = (v, lo, hi) => {
    let f;
    try { f = pyFloat(v); } catch { return null; }
    return Number.isNaN(f) ? null : Math.max(lo, Math.min(hi, f));
  };
  const color = (v) => {
    const s = String(v || "").trim();
    return COLOR_RX.test(s) ? s : null;
  };
  const spec = {};
  const shape = String(a.shape || "").toLowerCase().trim();
  if (MODEL_SHAPES.has(shape)) spec.shape = shape;
  if (a.dims !== undefined && a.dims !== null) {
    const d = number(a.dims, 4, 7);
    if (d) spec.dims = pyRound(d);
  }
  const formula = String(a.formula || "").trim().slice(0, 120);
  if (formula && FORMULA_RX.test(formula.toLowerCase())) {
    spec.formula = formula;
    if (!("shape" in spec)) spec.shape = "surface";
    const r = number(a.range, 0.1, 50);
    if (r) spec.range = r;
  }
  if (color(a.color)) spec.color = color(a.color);
  const title = String(a.title || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (title) spec.title = title;
  const parts = [];
  for (const pt of Array.isArray(a.parts) ? a.parts : []) {
    if (!isObj(pt) || parts.length >= 80) continue;
    const kind = String(pt.shape || pt.type || "box").toLowerCase().trim();
    if (!MODEL_PARTS.has(kind)) continue;
    const clean = { shape: kind };
    for (const k of ["pos", "size", "rot", "from", "to"]) {
      const v = nums(pt[k]);
      if (v !== null) clean[k] = v;
    }
    if (Array.isArray(pt.rot)) { // Drehung in Grad: ±720 statt ±50
      clean.rot = pt.rot.slice(0, 3).map((x) => {
        let f;
        try { f = pyFloat(x); } catch { f = 0; }
        return Number.isNaN(f) ? 0 : Math.max(-720, Math.min(720, f));
      });
    }
    for (const [k, lo, hi] of [["r", 0.001, 50], ["h", 0.001, 50], ["tube", 0.001, 20], ["sides", 3, 12], ["width", 0.5, 8]]) {
      const v = number(pt[k], lo, hi);
      if (v !== null) clean[k] = v;
    }
    if (color(pt.color)) clean.color = color(pt.color);
    parts.push(clean);
  }
  if (parts.length) {
    spec.parts = parts;
    delete spec.shape;
  }
  if (spec.shape === "nd") { // eigenes 4D/5D-Drahtmodell: Ecken (je dims Zahlen) und Kanten (Paare von Ecken)
    const dims = spec.dims ?? 4;
    let verts = (Array.isArray(a.vertices) ? a.vertices : []).slice(0, 256).map((v) => {
      const n = nums(v, dims);
      return n && n.length ? n : [];
    });
    verts = verts.map((v) => v.concat(new Array(Math.max(0, dims - v.length)).fill(0)));
    const edges = [];
    for (const e of (Array.isArray(a.edges) ? a.edges : []).slice(0, 1000)) {
      if (!Array.isArray(e) || e.length !== 2) continue;
      if (!e.every((i) => (typeof i === "number" && Number.isFinite(i)) || typeof i === "boolean")) continue;
      const i = Math.trunc(Number(e[0]));
      const j = Math.trunc(Number(e[1]));
      if (i >= 0 && i < verts.length && j >= 0 && j < verts.length && i !== j) edges.push([i, j]);
    }
    if (verts.length && edges.length) {
      spec.vertices = verts;
      spec.edges = edges;
    } else {
      spec.shape = "hypercube";
    }
  }
  if (!spec.shape && !spec.parts) spec.shape = "cube";
  return spec;
}

/** German name for the log line „3D · …“ (live jarvis.py L2690-2699). */
function modelName(spec) {
  if (spec.title) return spec.title;
  const d = spec.dims ?? 4;
  const de = { cube: "Würfel", box: "Quader", sphere: "Kugel", globe: "Globus", cylinder: "Zylinder", cone: "Kegel",
    pyramid: "Pyramide", prism: "Prisma", torus: "Torus", helix: "Helix", dna: "DNA", atom: "Atom", surface: "Fläche",
    hypercube: `${d}D-Würfel`, simplex: `${d}D-Tetraeder`, orthoplex: `${d}D-Oktaeder`, cell24: "24-Zeller",
    hypersphere: "4D-Kugel", clifford: "4D-Torus", nd: `${d}D-Modell` };
  return de[spec.shape] || spec.shape || "Modell";
}

// ---------------------------------------------------------------- normalisation (§6.4.3 field rules, aliases)

const WEATHER_DAYS = new Set(["heute", "morgen", "übermorgen", "montag", "dienstag", "mittwoch", "donnerstag",
  "freitag", "samstag", "sonntag", "wochenende", "woche"]);
const SPOTIFY_SEARCH_CMDS = new Set(["search", "artist", "playlist", "liked", "play"]);

function dropPrivate(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

function normDay(v) {
  let d = str(v, 20).toLowerCase().replace(/^am\s+/, "").replace(/ue/g, "ü");
  if (d === "uebermorgen") d = "übermorgen";
  if (WEATHER_DAYS.has(d) || /^in[1-7]$/.test(d)) return d;
  return "heute";
}

/**
 * Validate, coerce and alias a raw action (§6.4.3 field rules; Mac aliases whatsapp_write, site_search, open_site,
 * spotify {cmd}; remember/forget_note accept `fact` as an alias of `text`, `forget` → forget_note).
 * Mac-only types are returned unchanged so runAction can answer with MAC_ONLY.
 * @param {any} raw
 * @returns {Action|null} null = drop silently
 */
export function normalizeAction(raw) {
  if (!isObj(raw)) return null;
  const a = dropPrivate(raw);
  let type = str(a.type, 40).toLowerCase();
  // ---- aliases (Claude may still emit Mac types or first-PWA field names)
  if (type === "whatsapp_write") type = "whatsapp";
  if (type === "forget") type = "forget_note";
  if (type === "site_search") {
    const url = httpsOnly(a.url);
    return url ? { type: "open_url", url, label: str(a.query, 60) } : null;
  }
  if (type === "open_site") {
    const q = str(a.name ?? a.query, 200);
    return q ? { type: "web_search", query: q } : null;
  }
  if (type === "quit_app") {
    const names = Array.isArray(a.names) ? a.names.map((n) => str(n, 60)).filter(Boolean) : [str(a.name, 60)].filter(Boolean);
    return { type, names };
  }
  if (MAC_ONLY.has(type)) return { ...a, type };
  switch (type) {
    case "timer": {
      const n = typeof a.seconds === "number" ? a.seconds : parseAmount(String(a.seconds ?? ""));
      if (!Number.isFinite(n) || n <= 0) return null;
      return { type, seconds: Math.max(1, Math.min(86400, Math.trunc(n))), label: str(a.label, 30) };
    }
    case "timer_stop":
      return { type, label: str(a.label, 30) };
    case "weather":
      return { type, place: str(a.place, 80), day: normDay(a.day) };
    case "show_image": {
      const query = str(a.query, 120);
      return query ? { type, query } : null;
    }
    case "next_image":
    case "hide_image":
    case "hide_model":
    case "orb_reset":
    case "hide_jarvis":
      return { type };
    case "open_url": {
      const url = httpsOnly(a.url);
      return url ? { type, url, label: str(a.label ?? a.name, 60) } : null;
    }
    case "web_search":
    case "youtube":
    case "amazon": {
      const query = str(a.query ?? a.q, 200);
      return query ? { type, query } : null;
    }
    case "spotify": {
      const cmd = str(a.cmd, 20).toLowerCase();
      const title = str(a.title, 120);
      const artist = str(a.artist, 120);
      let query = str(a.query, 200);
      if (cmd === "liked" && !query && !title) query = "Lieblingssongs";
      if (cmd === "artist" && !query && artist && !title) query = artist;
      const has = !!(title || query || artist);
      if (cmd && (!SPOTIFY_SEARCH_CMDS.has(cmd) || !has)) return { type: "media", cmd };
      if (!has) return null;
      const out = { type };
      if (title) out.title = title;
      if (artist) out.artist = artist;
      if (query) out.query = query;
      return out;
    }
    case "maps": {
      const query = str(a.query ?? a.place ?? a.destination, 200);
      return query ? { type, query } : null;
    }
    case "route": {
      const destination = str(a.destination ?? a.ziel ?? a.query, 200);
      return destination ? { type, destination } : null;
    }
    case "call":
      return { type, number: str(a.number ?? a.phone, 40), name: str(a.name ?? a.to, 60) };
    case "whatsapp": {
      const text = String(a.text ?? "").trim().slice(0, 1500);
      const to = str(a.to ?? a.name, 60);
      const phone = str(a.phone ?? a.number, 40);
      if (!text && !to && !phone) return null;
      return { type, text, to, phone };
    }
    case "remember":
    case "forget_note":
      return { type, text: str(a.text ?? a.fact, 400) };
    case "show_model": {
      const out = { type };
      for (const k of ["title", "shape", "dims", "formula", "range", "color", "parts", "vertices", "edges"]) {
        if (a[k] !== undefined) out[k] = a[k];
      }
      return out;
    }
    case "model_adjust": {
      const op = str(a.op, 20).toLowerCase();
      return MODEL_OPS.has(op) ? { type, op } : null;
    }
    case "orb_zoom": {
      let op = str(a.op, 20).toLowerCase();
      if (op === "normal") op = "reset";
      return op === "bigger" || op === "smaller" || op === "reset" ? { type, op } : null;
    }
    case "learn_command": {
      const actions = (Array.isArray(a.actions) ? a.actions : []).map(normalizeAction).filter(Boolean);
      return { type, phrase: str(a.phrase, 200), actions };
    }
    case "forget_command":
      return { type, phrase: str(a.phrase, 200) };
    case "einnahme":
      return { type, betrag: parseAmount(a.betrag), quelle: str(a.quelle, 40), text: str(a.text, 80) };
    case "kontostand":
      return { type, betrag: parseAmount(a.betrag) };
    case "termin":
      return { type, titel: str(a.titel ?? a.title, 80), wann: str(a.wann, 30), ort: str(a.ort, 80) };
    case "termin_loeschen": {
      const out = { type, titel: str(a.titel ?? a.title, 80), wann: str(a.wann, 30) };
      if (a.id) out.id = str(a.id, 40);
      return out.titel || out.wann || out.id ? out : null;
    }
    case "set_setting":
      return { type, key: str(a.key, 40).toLowerCase(), value: a.value };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- links

/**
 * @param {string} url
 * @returns {string|null} the URL when it is a valid https:// URL, else null
 */
export function httpsOnly(url) {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} number digits, "+", spaces; ≥ 3 digits
 * @returns {string|null} "tel:<+digits>" or null when invalid
 */
export function telLink(number) {
  const s = String(number ?? "").trim();
  if (!s || /[^\d+\s\-/().]/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 3) return null;
  return "tel:" + (s.startsWith("+") ? "+" : "") + digits;
}

/**
 * @param {{ text: string, phone?: string }} msg
 * @returns {string} https://wa.me/<digits>?text=<enc> or https://wa.me/?text=<enc>
 */
export function waLink({ text, phone } = {}) {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (/^0[1-9]/.test(digits)) digits = "49" + digits.slice(1); // nationale Nummer: Ländervorwahl Deutschland
  const t = String(text ?? "").trim();
  const q = t ? `?text=${encodeURIComponent(t)}` : "";
  return digits.length >= 6 ? `https://wa.me/${digits}${q}` : `https://wa.me/${q || ""}`;
}

/** Apple Karten nur auf iPhone/iPad und in Safari am Mac; sonst Google Maps (öffnet auf Android die Maps-App, CR3.1). */
export function appleMaps() {
  try {
    if (typeof navigator === "undefined") return false;
    const ua = String(navigator.userAgent || "");
    if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return true;
    return /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua);
  } catch { return false; }
}

/**
 * @param {string} query
 * @param {boolean} [apple] default: appleMaps()
 * @returns {string} https://maps.apple.com/?q=<enc> | https://www.google.com/maps/search/?api=1&query=<enc> (Mac L3080)
 */
export function mapsLink(query, apple = appleMaps()) {
  const q = encodeURIComponent(String(query ?? "").trim());
  return apple ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

/**
 * @param {string} destination
 * @param {boolean} [apple] default: appleMaps()
 * @returns {string} https://maps.apple.com/?daddr=<enc>&dirflg=d | https://www.google.com/maps/dir/?api=1&destination=<enc> (Mac L3729)
 */
export function routeLink(destination, apple = appleMaps()) {
  const d = encodeURIComponent(String(destination ?? "").trim());
  return apple ? `https://maps.apple.com/?daddr=${d}&dirflg=d` : `https://www.google.com/maps/dir/?api=1&destination=${d}`;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/**
 * Pure: the Link for a LINK_ACTIONS action (labels per ARCHITECTURE.md §5.1 "link buttons"; hud shortens them).
 * @param {Action} action normalised
 * @returns {Link|null}
 */
export function linkFor(action) {
  if (!isObj(action)) return null;
  const enc = encodeURIComponent;
  switch (action.type) {
    case "open_url": {
      const url = httpsOnly(action.url);
      return url ? { url, label: str(action.label, 60) || hostOf(url), icon: "↗" } : null;
    }
    case "web_search":
      return action.query ? { url: `https://www.google.com/search?q=${enc(action.query)}`, label: `Google: ${action.query}`, icon: "↗" } : null;
    case "youtube":
      return action.query ? { url: `https://www.youtube.com/results?search_query=${enc(action.query)}`, label: `YouTube: ${action.query}`, icon: "▶" } : null;
    case "spotify": {
      const q = action.title ? `${action.title} ${action.artist || ""}`.trim() : str(action.query) || str(action.artist);
      return q ? { url: `https://open.spotify.com/search/${enc(q)}`, label: `Spotify: ${q}`, icon: "♫" } : null;
    }
    case "maps":
      return action.query ? { url: mapsLink(action.query), label: `Karte: ${action.query}`, icon: "⌖" } : null;
    case "route":
      return action.destination ? { url: routeLink(action.destination), label: `Route: ${action.destination}`, icon: "⌖" } : null;
    case "amazon":
      return action.query ? { url: `https://www.amazon.de/s?k=${enc(action.query)}`, label: `Amazon: ${action.query}`, icon: "🛒" } : null;
    case "call": {
      const url = telLink(action.number);
      return url ? { url, label: `Anrufen: ${action.name || action.number}`, icon: "☎" } : null;
    }
    case "whatsapp":
      return { url: waLink({ text: action.text, phone: action.phone }),
        label: action.to ? `WhatsApp: an ${action.to}` : "WhatsApp-Entwurf", icon: "✉" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- weather (jarvis.py L1768-1902)

const WMO = { 0: "klar", 1: "überwiegend klar", 2: "teils bewölkt", 3: "bedeckt", 45: "Nebel", 48: "Nebel mit Reif",
  51: "leichter Nieselregen", 53: "Nieselregen", 55: "starker Nieselregen", 56: "gefrierender Nieselregen",
  57: "gefrierender Nieselregen", 61: "leichter Regen", 63: "Regen", 65: "starker Regen",
  66: "gefrierender Regen", 67: "gefrierender Regen", 71: "leichter Schneefall", 73: "Schneefall",
  75: "starker Schneefall", 77: "Schneegriesel", 80: "leichte Regenschauer", 81: "Regenschauer",
  82: "heftige Regenschauer", 85: "Schneeschauer", 86: "starke Schneeschauer", 95: "Gewitter",
  96: "Gewitter mit Hagel", 99: "schweres Gewitter mit Hagel" };
// Mac WEEKDAY_KEYS (Monday first) → JS getDay() index
const WEEKDAY_KEYS = { montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonntag: 0 };
const GEO = new Map();

function wmo(code, day = true) {
  const c = Math.trunc(Number(code || 0));
  if ((c === 0 || c === 1) && day) return c === 0 ? "sonnig" : "überwiegend sonnig";
  return WMO[c] ?? "wechselhaft";
}

function deg(x) {
  const n = pyRound(Number(x) || 0);
  return n < 0 ? `minus ${-n}` : String(n === 0 ? 0 : n);
}

/** Similarity 0..1 (normalised Levenshtein; replaces Python difflib in the Mac name filter). */
function similarity(a, b) {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function geoURL(place, lang) {
  return `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=10&language=${lang}&format=json`;
}

/**
 * open-meteo geocoding with Mac-style scoring relative to the Wohnort (§7.6 note); 6 s timeout.
 * @param {string} place
 * @param {{ signal?: AbortSignal, near?: string }} [opts]
 * @returns {Promise<{ name: string, latitude: number, longitude: number, country_code: string, admin1: string } | null>}
 */
export async function geocode(place, { signal, near } = {}) {
  const name = String(place ?? "").trim();
  const key = name.toLowerCase();
  if (!key) return null;
  const nearKey = String(near ?? "").toLowerCase().trim();
  const cacheKey = `${key}|${nearKey === key ? "" : nearKey}`;
  if (GEO.has(cacheKey)) return GEO.get(cacheKey);
  let res = (await getJSON(geoURL(name, "de"), signal))?.results || [];
  const lname = (r) => String(r?.name || "").toLowerCase();
  if (!res.some((r) => lname(r) === key && r.population)) {
    try { // z. B. „New York“: auf Deutsch fehlt die Stadt, auf Englisch ist sie dabei
      res = res.concat((await getJSON(geoURL(name, "en"), signal))?.results || []);
    } catch (e) {
      if (isAbort(e, signal)) throw e;
    }
  }
  res = res.filter((r) => r && Number.isFinite(Number(r.latitude)) && Number.isFinite(Number(r.longitude))
    && (lname(r).includes(key) || key.includes(lname(r)) && lname(r) || similarity(key, lname(r)) >= 0.75));
  let home = null;
  if (nearKey && nearKey !== key) {
    try { home = await geocode(near, { signal }); } catch (e) { if (isAbort(e, signal)) throw e; }
  }
  const homeCC = home?.country_code || "DE";
  const score = (r) => ((Number(r.population) || 0) + 1000) * (r.country_code === homeCC ? 6 : 1)
    * (home && r.admin1 && r.admin1 === home.admin1 ? 3 : 1) * (lname(r) === key ? 2 : 1);
  let best = null;
  for (const r of res) if (!best || score(r) > score(best)) best = r;
  const out = best ? { name: best.name || name, latitude: Number(best.latitude), longitude: Number(best.longitude),
    country_code: best.country_code || "", admin1: best.admin1 || "" } : null;
  GEO.set(cacheKey, out);
  return out;
}

/**
 * Spoken weather report, port of Mac weather_report (jarvis.py L1817-1902).
 * @param {string} place empty → homeCity
 * @param {string} day heute|morgen|übermorgen|montag…sonntag|wochenende|woche|in1…in7
 * @param {{ homeCity?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<string>}
 */
export async function weatherReport(place, day, { homeCity, signal } = {}) {
  const home = String(homeCity ?? "").trim();
  const where = String(place ?? "").trim() || home;
  if (!where) return say("weatherNoHome");
  const dayKey = normDay(day || "heute");
  let geo;
  try {
    geo = await geocode(where, { signal, near: home });
  } catch (e) {
    if (isAbort(e, signal) && signal?.aborted) throw e;
    return say("weatherNoData");
  }
  if (!geo) return say("weatherNoPlace", { place: where });
  let w;
  let d;
  let dates;
  try {
    w = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}`
      + "&timezone=auto&forecast_days=8&current=temperature_2m,weather_code,is_day"
      + "&hourly=precipitation_probability,weather_code"
      + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,"
      + "wind_gusts_10m_max", signal);
    d = w.daily;
    dates = d.time.map((x) => {
      const [y, m, dd] = String(x).split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    });
    if (!dates.length || dates.some((x) => Number.isNaN(x))) throw new Error("daily");
  } catch (e) {
    if (signal?.aborted) throw e;
    return say("weatherNoData");
  }
  const name = geo.name || where;
  const at = (k, i) => Number((d[k] || [])[i] ?? 0) || 0;
  const wd = (i) => WEEKDAYS[dates[i]];
  const rain = (i) => {
    const p = at("precipitation_probability_max", i);
    const mm = at("precipitation_sum", i);
    const code = Math.trunc(at("weather_code", i));
    return p >= 40 && mm >= 0.3 ? `, Regenrisiko ${p} Prozent` : p < 25 && mm < 0.3 && code < 51 ? ", trocken" : "";
  };
  const wind = (i) => {
    const g = at("wind_gusts_10m_max", i);
    return g >= 75 ? ", Sturmböen" : g >= 50 ? ", windig" : "";
  };
  const line = (i) => `${deg(at("temperature_2m_min", i))} bis ${deg(at("temperature_2m_max", i))} Grad, `
    + `${wmo(at("weather_code", i))}${rain(i)}${wind(i)}`;
  const span = Math.min(7, dates.length);
  if (dayKey === "woche") {
    const idx = Array.from({ length: span }, (_, i) => i);
    const wet = idx.filter((i) => at("precipitation_probability_max", i) >= 60 && at("precipitation_sum", i) >= 1).map(wd);
    let warm = 0;
    for (const i of idx) if (at("temperature_2m_max", i) > at("temperature_2m_max", warm)) warm = i;
    const text = `Die nächsten Tage in ${name}: ${deg(Math.min(...idx.map((i) => at("temperature_2m_min", i))))} bis `
      + `${deg(Math.max(...idx.map((i) => at("temperature_2m_max", i))))} Grad, am wärmsten am ${wd(warm)}.`;
    if (wet.length) {
      return text + " Regen vor allem am " + (wet.length > 1 ? `${wet.slice(0, -1).join(", ")} und ${wet[wet.length - 1]}` : wet[0]) + ".";
    }
    return text + " Kaum Regen.";
  }
  if (dayKey === "wochenende") {
    let idx;
    if (dates[0] === 0) idx = [0];
    else {
      let sat = -1;
      for (let i = 0; i < span; i++) if (dates[i] === 6) { sat = i; break; }
      idx = sat >= 0 ? [sat, sat + 1].filter((i) => i < dates.length) : [0];
    }
    return `Am Wochenende in ${name}: ` + idx.map((i) => `${wd(i)} ${line(i)}`).join("; ") + ".";
  }
  let i = 0;
  if (dayKey in WEEKDAY_KEYS) {
    for (let k = 0; k < span; k++) if (dates[k] === WEEKDAY_KEYS[dayKey]) { i = k; break; }
  } else if (/^in[1-7]$/.test(dayKey)) {
    i = Math.min(Number(dayKey.slice(2)), dates.length - 1);
  } else {
    i = { morgen: 1, übermorgen: 2 }[dayKey] ?? 0;
  }
  if (i) {
    const label = i === 1 ? "Morgen" : i === 2 ? "Übermorgen" : `Am ${wd(i)}`;
    return `${label} in ${name}: ${line(i)}.`;
  }
  const c = w.current || {};
  const nowTxt = `In ${name} gerade ${deg(c.temperature_2m ?? 0)} Grad, ${wmo(c.weather_code, c.is_day ?? 1)}.`;
  let rest = `Heute ${deg(at("temperature_2m_min", 0))} bis ${deg(at("temperature_2m_max", 0))} Grad`;
  if (Math.trunc(Number(c.weather_code || 0)) < 51) { // regnet es nicht gerade: wann wird es heute nass?
    const h = w.hourly || {};
    const now = String(c.time || `${d.time[0]}T00:00`);
    const nowHour = now.slice(0, 13) + ":00";
    let wet = null;
    let dry = true;
    const times = h.time || [];
    for (let k = 0; k < times.length; k++) {
      const when = String(times[k]);
      if (when.slice(0, 10) !== now.slice(0, 10) || when < nowHour) continue;
      const prob = Number((h.precipitation_probability || [])[k] ?? 0) || 0;
      const code = Number((h.weather_code || [])[k] ?? 0) || 0;
      dry = dry && prob < 30;
      if (wet === null && prob >= 50 && code >= 51) wet = when;
    }
    rest += wet ? `, ab etwa ${Number(wet.slice(11, 13))} Uhr Regen` : dry ? ", trocken" : "";
  }
  return `${nowTxt} ${rest}${wind(0)}.`;
}

// ---------------------------------------------------------------- images (Wikipedia)

let FOUND = null;       // { key, query, cands: [], stage, seen: Set }
let SHOWN = null;       // { query, idx } – last image handed out (Mac FOUND_IMAGE)

async function imageStage(cache, stage, signal) {
  const lang = stage < 2 ? "de" : "en";
  const q = cache.query;
  const push = (src, width, height, pageUrl) => {
    if (!src || cache.seen.has(src)) return;
    cache.seen.add(src);
    cache.cands.push({ src, width: Number(width) || 0, height: Number(height) || 0, pageUrl: pageUrl || "" });
  };
  if (stage % 2 === 0) {
    const title = (q[0].toUpperCase() + q.slice(1)).replace(/ /g, "_");
    try {
      const j = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, signal);
      const page = j?.content_urls?.desktop?.page || "";
      const orig = j?.originalimage;
      const thumb = j?.thumbnail;
      if (orig?.source && Number(orig.width) <= 2000) push(orig.source, orig.width, orig.height, page);
      else if (thumb?.source) push(thumb.source, thumb.width, thumb.height, page);
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    return;
  }
  try {
    const j = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search`
      + `&gsrsearch=${encodeURIComponent(q)}&gsrlimit=8&prop=pageimages&piprop=thumbnail|original&pithumbsize=1200`, signal);
    const pages = Object.values(j?.query?.pages || {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const p of pages) {
      if (!p?.thumbnail?.source) continue;
      push(p.thumbnail.source, p.thumbnail.width, p.thumbnail.height,
        `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(p.title || "").replace(/ /g, "_"))}`);
    }
  } catch (e) {
    if (signal?.aborted) throw e;
  }
}

/**
 * Wikipedia image search (de REST summary → de search API → en), candidates remembered for next_image.
 * @param {string} query
 * @param {{ skip?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ src: string, width: number, height: number, caption: string, pageUrl: string } | null>}
 */
export async function findImage(query, { skip = 0, signal } = {}) {
  const q = String(query ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!q) return null;
  const key = q.toLowerCase();
  if (!FOUND || FOUND.key !== key) FOUND = { key, query: q, cands: [], stage: 0, seen: new Set() };
  const cache = FOUND;
  const want = Math.max(0, Math.trunc(Number(skip) || 0));
  while (cache.cands.length <= want && cache.stage < 4) {
    const stage = cache.stage++;
    await imageStage(cache, stage, signal);
  }
  const c = cache.cands[want];
  if (!c) return null;
  SHOWN = { query: q, idx: want };
  return { src: c.src, width: c.width, height: c.height, caption: `${nice(q)} · WIKIPEDIA`, pageUrl: c.pageUrl };
}

/** @returns {string|null} query of the last shown image (for next_image) */
export function lastImageQuery() {
  return SHOWN ? SHOWN.query : null;
}

// ---------------------------------------------------------------- settings by voice (Mac change_setting L1649-1684)

function fmtLimit(v, type) {
  return type === "float" && Number.isInteger(v) ? v.toFixed(1) : String(v);
}

function changeSetting(key, value, anrede) {
  const spec = SETTING_KEYS[key];
  if (!spec) return { err: say("settingUnknown", {}, anrede) };
  let v;
  if (spec.type === "str") {
    v = value === undefined || value === null ? "" : String(value).trim();
    if (!(v.length >= spec.min && v.length <= spec.max)) return { err: say("settingValue", {}, anrede) };
  } else {
    let f;
    try { f = pyFloat(String(value ?? "").replace(/,/g, ".").replace(/%+$/, "")); } catch { f = NaN; }
    if (Number.isNaN(f) || (spec.type === "int" && !Number.isFinite(f))) return { err: say("settingValue", {}, anrede) };
    v = spec.type === "int" ? Math.trunc(f) : f;
    if (!(v >= spec.min && v <= spec.max)) {
      return { err: say("settingRange", { what: spec.what, lo: fmtLimit(spec.min, spec.type), hi: fmtLimit(spec.max, spec.type) }, anrede) };
    }
  }
  store.setSettings({ [spec.key]: v });
  return { err: "", value: v };
}

// ---------------------------------------------------------------- run

function learnAllowed(ctx) {
  const rx = intents.LEARN_SIGNAL;
  if (!(rx instanceof RegExp)) return true; // app.js applies the guard itself (§4.6)
  rx.lastIndex = 0;
  return !ctx.webSeen && rx.test(String(ctx.said ?? "").toLowerCase());
}

/**
 * Execute one normalised action. Never throws: on any exception → { type, ok: false, say: LINES.actionFailed }.
 * Defence in depth: when ctx.webUsed and the type is not in SAFE_AFTER_WEB → { type, ok: false, blocked: true }
 * without executing; a learn action from Claude without the user's own learn words → learnOnlyOwn (app.js already
 * filters both before calling, ARCHITECTURE.md §4.6).
 * @param {Action} action
 * @param {ActionContext} ctx
 * @returns {Promise<ActionResult>}
 */
export async function runAction(action, ctx = {}) {
  const type = isObj(action) ? String(action.type || "") : "";
  const A = String(ctx?.anrede || "").trim() || safeAnrede();
  try {
    if (!type) return { type, ok: false };
    const c = isObj(ctx) ? ctx : {};
    if (c.webUsed && !SAFE_AFTER_WEB.has(type)) return { type, ok: false, blocked: true };
    if (c.fromClaude && LEARN_ACTIONS.has(type) && !learnAllowed(c)) {
      return { type, ok: false, blocked: true, say: say("learnOnlyOwn", {}, A) };
    }
    if (MAC_ONLY.has(type)) return { type, ok: false, macOnly: true, say: say(MAC_ONLY.get(type), {}, A) };
    const now = c.now instanceof Date ? c.now : new Date();
    const signal = c.signal;
    const a = action;
    switch (type) {
      case "timer": {
        const t = store.addTimer(a.seconds, a.label || "", now.getTime());
        return { type, ok: true, timer: t,
          log: { kind: "tool", text: `Timer · ${sayDuration(t.seconds)}${t.label ? " · " + t.label : ""}` } };
      }
      case "timer_stop": {
        const gone = store.cancelTimers(a.label || undefined);
        if (!gone.length) return { type, ok: false, say: say("noTimer", {}, A) };
        return { type, ok: true, timer: gone[0], say: say("timerStopped", {}, A) };
      }
      case "weather": {
        const home = String(c.wohnort ?? store.settings().wohnort ?? "").trim();
        const place = String(a.place || "").trim();
        if (!place && !home) return { type, ok: false, say: say("weatherNoHome", {}, A) };
        const text = await weatherReport(place, a.day || "heute", { homeCity: home, signal });
        return { type, ok: true, say: text, log: { kind: "tool", text: `Wetter · ${place || home}` } };
      }
      case "show_image": {
        const img = await findImage(a.query, { signal });
        if (!img) return { type, ok: false, say: say("imageNone", { query: a.query }, A) };
        return { type, ok: true, image: { src: img.src, caption: img.caption }, log: { kind: "tool", text: `Bild · ${a.query}` } };
      }
      case "next_image": {
        const q = lastImageQuery();
        if (!q) return { type, ok: false, say: say("imageNoneYet", {}, A) };
        const img = await findImage(q, { skip: (SHOWN?.idx ?? 0) + 1, signal });
        if (!img) return { type, ok: false, say: say("imageNoMore", { query: q }, A) };
        return { type, ok: true, image: { src: img.src, caption: img.caption }, log: { kind: "tool", text: `Bild · ${q}` } };
      }
      case "hide_image":
        return { type, ok: true, ui: "hide_image" };
      case "open_url":
      case "web_search":
      case "youtube":
      case "spotify":
      case "maps":
      case "route":
      case "amazon":
      case "call": {
        const link = linkFor(a);
        if (!link) return type === "call" ? { type, ok: false, say: say("callNoNumber", {}, A) } : { type, ok: false };
        return { type, ok: true, link, log: { kind: "tool", text: `Öffnen · ${link.label}` } };
      }
      case "whatsapp": {
        const link = linkFor(a);
        return { type, ok: true, link, log: { kind: "draft", text: a.text || link.label },
          say: a.to ? say("waReady", { to: a.to }, A) : say("waReadyNoTo", {}, A) };
      }
      case "remember": {
        const err = store.addFact(a.text, now.getTime());
        if (err) return { type, ok: false, say: err };
        return { type, ok: true, log: { kind: "tool", text: `Gemerkt · ${str(a.text, 240)}` } };
      }
      case "forget_note": {
        const err = store.forgetFact(a.text);
        if (err) return { type, ok: false, say: err };
        return { type, ok: true, log: { kind: "tool", text: `Vergessen · ${a.text}` } };
      }
      case "show_model": {
        const spec = modelSpec(a);
        return { type, ok: true, model: spec, log: { kind: "tool", text: `3D · ${modelName(spec)}` } };
      }
      case "hide_model":
        return { type, ok: true, model: null };
      case "model_adjust":
        return MODEL_OPS.has(a.op) ? { type, ok: true, modelOp: a.op } : { type, ok: false };
      case "orb_zoom":
        return ["bigger", "smaller", "reset"].includes(a.op)
          ? { type, ok: true, orb: { op: a.op === "reset" ? "normal" : a.op } } : { type, ok: false };
      case "orb_reset":
        return { type, ok: true, orb: { op: "reset" } };
      case "learn_command": {
        const actions = (Array.isArray(a.actions) ? a.actions : []).map(normalizeAction).filter(Boolean);
        const err = store.learnShortcut(a.phrase, actions, now.getTime());
        if (err) return { type, ok: false, say: say("learnFail", {}, A) };
        return { type, ok: true, log: { kind: "tool", text: `Kurzbefehl · ${store.normPhrase(a.phrase)}` } };
      }
      case "forget_command": {
        const err = store.forgetShortcut(a.phrase);
        if (err) return { type, ok: false, say: say("forgetUnknown", { phrase: store.normPhrase(a.phrase) }, A) };
        return { type, ok: true, log: { kind: "tool", text: `Kurzbefehl vergessen · ${store.normPhrase(a.phrase)}` } };
      }
      case "hide_jarvis":
        return { type, ok: true, ui: "stealth" };
      case "einnahme": {
        const err = store.applyEinnahme({ betrag: a.betrag, quelle: a.quelle, text: a.text }, now.getTime());
        if (err) return { type, ok: false, say: say("kontoValue", {}, A) };
        return { type, ok: true, log: { kind: "tool", text: `Konto · +${money(a.betrag)}${a.quelle ? " · " + a.quelle : ""}` } };
      }
      case "kontostand": {
        const err = store.setKontostand(a.betrag, now.getTime());
        if (err) return { type, ok: false, say: say("kontoValue", {}, A) };
        return { type, ok: true, log: { kind: "tool", text: `Konto · ${money(a.betrag)}` } };
      }
      case "termin": {
        const err = store.addTermin({ titel: a.titel, wann: a.wann, ort: a.ort }, now.getTime());
        if (err) return { type, ok: false, say: say("terminValue", {}, A) };
        return { type, ok: true, log: { kind: "tool", text: `Termin · ${a.titel}` } };
      }
      case "termin_loeschen": {
        const n = store.removeTermin({ id: a.id, titel: a.titel, wann: a.wann });
        if (!n) return { type, ok: false, say: say("terminNone", {}, A) };
        return { type, ok: true, log: { kind: "tool", text: `Termin gelöscht · ${a.titel || a.wann}` } };
      }
      case "set_setting": {
        const { err, value } = changeSetting(a.key, a.value, A);
        if (err) return { type, ok: false, say: err };
        return { type, ok: true, log: { kind: "tool", text: `Einstellung · ${a.key} = ${typeof value === "string" ? `„${value}“` : value}` } };
      }
      default:
        return { type, ok: false, log: { kind: "system", text: `Unbekannte Aktion: ${type}` } };
    }
  } catch (e) {
    if (ctx?.signal?.aborted) return { type, ok: false };
    return { type, ok: false, say: say("actionFailed", {}, A) };
  }
}
