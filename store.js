// ==============================================================================================================
// CONTRACT – store.js (owner: builder BRAIN). Spec: ARCHITECTURE.md §3.2.1 and §8.
// All persistence of the phone Jarvis: settings, notes („merk dir …“, like the Mac data/gelernt.json), learned
// shortcuts, konto/termine, timers, chat history, protocol log, usage, Setup-Link export/import, wipe.
// Pure data: no DOM, imports nothing. (hud keeps the orb position/zoom under KEYS.orb itself; wipe("all") clears it.)
// Every write is `try { localStorage.setItem(...) } catch {}`; without storage the module keeps an in-memory copy
// and init() reports storage "memory". Reads tolerate corrupt JSON (defaults, never throw).
// No secrets and no personal data in this file: personal values only ever come from the setup screen.
// Regexes ported from jarvis.py are written Unicode-aware by hand here (store.js imports nothing, §2).
// Round 2: importFromLocation() strips #cfg=/?wake=1 from the address first, then only reads the link (pending, never
// keys); applySetup() applies it after the user said yes. Keys move only with the pasted Setup-Code (setupCode(),
// readSetupCode());
// the history keeps the first message with the notes when it is trimmed and carries webSeen (D18 across reloads);
// wipe("all") also empties the "jarvis-tts" speech cache (wipeDone()); a "storage" event from another window of the
// same origin reloads the changed key, so two windows never write back each other's stale state.
// ==============================================================================================================

/** @typedef {typeof DEFAULT_SETTINGS} Settings  ARCHITECTURE.md §8.2 (frozen snapshot; closingPhrase null = default line, "" = none) */
/** @typedef {{ id: string, label: string, ends: number, created: number, seconds: number }} Timer */
/** @typedef {{ kind: "jarvis"|"user"|"tool"|"system"|"error"|"draft", text: string, at: number }} LogEntry */
/** @typedef {{ role: "user"|"assistant", content: string }} ChatMessage */
/** @typedef {{ type: string, [field: string]: any }} Action */

export const VERSION = 2;

export const KEYS = Object.freeze({
  settings: "jarvis.v2.settings",
  facts: "jarvis.v2.facts",
  shortcuts: "jarvis.v2.shortcuts",
  konto: "jarvis.v2.konto",
  timers: "jarvis.v2.timers",
  history: "jarvis.v2.history",
  log: "jarvis.v2.log",
  usage: "jarvis.v2.usage",
  meta: "jarvis.v2.meta",
  orb: "jarvis.v2.orb", // written by hud.js ({ x, y, zoom }); store only removes it in wipe("all")
});

/** v1 keys of the first phone PWA; migrated once by init() (§8.5), then removed. */
export const LEGACY_KEYS = Object.freeze({ settings: "jarvis-settings-v1", timers: "jarvis-timers" });

/** §8.2 – defaults from the Mac config (timings, closing phrase, speak budget, image 7 s, idle fade 45 s, galaxy .3). */
export const DEFAULT_SETTINGS = Object.freeze({
  v: 2,
  anrede: "Boss", vorname: "", firma: "", wohnort: "",
  anthropicKey: "", geminiKey: "", brainProvider: "auto", azureKey: "", azureRegion: "germanywestcentral",
  voicePreset: "geraet", voiceSpeed: 0,                  // CHANGES-1 CR1.2/CR2: free device voice, auto brain
  wakeWord: true, startInBackground: false, listenOnOpen: false, greeting: true, keepAwake: true,
  theme: "mac", focus: false, deckPage: 2, autoHideMinutes: 10,
  gedaechtnis: "",
  closingPhrase: null,
  silenceSeconds: 2.0, hesitationSeconds: 2.8, maxRecordSeconds: 50, noSpeechSeconds: 6, followUpSeconds: 4,
  followUpAfterAnswer: false, speakMaxSentences: 3, speakMaxChars: 380, imageSeconds: 7, idleFadeSeconds: 45,
  galaxyBrightness: 0.3,
});

/** §8.2 – numeric clamps [min, max] applied by setSettings(). Enums and string lengths: see §8.2. */
export const LIMITS = Object.freeze({
  voiceSpeed: Object.freeze([-30, 50]),
  autoHideMinutes: Object.freeze([0, 120]),
  deckPage: Object.freeze([0, 5]),
  silenceSeconds: Object.freeze([0.6, 4.0]),
  hesitationSeconds: Object.freeze([1.0, 5.0]),
  maxRecordSeconds: Object.freeze([10, 90]),
  noSpeechSeconds: Object.freeze([3, 15]),
  followUpSeconds: Object.freeze([2, 10]),
  speakMaxSentences: Object.freeze([1, 8]),
  speakMaxChars: Object.freeze([120, 1200]),
  imageSeconds: Object.freeze([3, 120]),
  idleFadeSeconds: Object.freeze([10, 600]),
  galaxyBrightness: Object.freeze([0, 1]),
});

/** §8.1 – size limits (notes: Mac keeps 80 of ≤ 240 chars and sends the last 60). */
export const MAX = Object.freeze({
  history: 24, log: 60, facts: 80, factChars: 240, notesInPrompt: 60, shortcuts: 50, gedaechtnisChars: 4000,
  termine: 200, buchungen: 500, verlauf: 30, timers: 20,
});

/** §6.4.3 – action types a learned voice shortcut may contain (live Mac list minus Mac-only types; no call/whatsapp). */
export const SHORTCUT_ACTIONS = Object.freeze(new Set([
  "timer", "timer_stop", "weather", "show_image", "hide_image", "open_url", "web_search", "youtube", "spotify",
  "maps", "route", "amazon", "hide_jarvis", "show_model", "hide_model", "model_adjust", "orb_reset", "orb_zoom",
]));

// ---------------------------------------------------------------- private: validation tables

const PRESET_KEYS = new Set(["geraet", "butler", "florian", "killian", "andrew"]);
const FREE_PRESET = "geraet";                // CR1.2: without an Azure key Jarvis never tries Azure
const PROVIDERS = new Set(["auto", "claude", "gemini"]);   // CR2.1
const THEMES = new Set(["mac", "tuerkis"]);
const REGIONS = new Set(["germanywestcentral", "westeurope", "northeurope", "swedencentral", "francecentral",
  "uksouth", "switzerlandnorth", "eastus", "westus2"]);
const STRING_MAX = { anrede: 20, vorname: 40, firma: 60, wohnort: 60, gedaechtnis: MAX.gedaechtnisChars,
  closingPhrase: 80, anthropicKey: 400, geminiKey: 400, azureKey: 400 };
const INT_KEYS = new Set(["voiceSpeed", "autoHideMinutes", "deckPage", "maxRecordSeconds", "noSpeechSeconds",
  "followUpSeconds", "speakMaxSentences", "speakMaxChars", "imageSeconds", "idleFadeSeconds"]);
const TOPICS = ["settings", "facts", "shortcuts", "konto", "timers", "history", "log", "usage"];
const LOG_KINDS = new Set(["jarvis", "user", "tool", "system", "error", "draft"]);
const WORD = "\\p{L}\\p{N}_"; // Python re \w (Unicode) for the hand-ported regexes below

// ---------------------------------------------------------------- private: storage backend

let backend = null;          // localStorage or null
let storageMode = "memory";
let ready = false;
const mem = new Map();       // in-memory mirror (authoritative for "memory" mode)

function probeStorage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const k = "jarvis.v2.__probe__";
    ls.setItem(k, "1");
    ls.removeItem(k);
    return ls;
  } catch {
    return null;
  }
}

function rawGet(key) {
  if (backend) {
    try {
      const v = backend.getItem(key);
      if (v !== null) return v;
    } catch { /* fall through to the mirror */ }
  }
  return mem.has(key) ? mem.get(key) : null;
}

function readJSON(key, fallback) {
  const raw = rawGet(key);
  if (raw == null) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  const raw = JSON.stringify(value);
  mem.set(key, raw);
  if (backend) {
    try { backend.setItem(key, raw); } catch { /* quota / private mode: memory copy stays */ }
  }
}

function removeKey(key) {
  mem.delete(key);
  if (backend) {
    try { backend.removeItem(key); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- private: state

let state = {
  settings: DEFAULT_SETTINGS,
  facts: [],
  shortcuts: [],
  konto: null,
  timers: [],
  history: { v: 1, updated: 0, messages: [], webSeen: false },
  log: [],
  usage: { day: "", input: 0, output: 0, requests: 0 },
  meta: { installedAt: 0, lastBoot: 0, lastImportT: 0, migratedFromV1: 0 },
};

const listeners = new Map(TOPICS.map((t) => [t, new Set()]));

function emit(topic, value) {
  const set = listeners.get(topic);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(value); } catch { /* a broken listener must not break the store */ }
  }
}

function ensure() {
  if (!ready) init();
}

// ---------------------------------------------------------------- private: helpers

const pad2 = (n) => String(n).padStart(2, "0");
const toDate = (now) => (now instanceof Date ? new Date(now.getTime()) : new Date(typeof now === "number" ? now : Date.now()));
const nowMs = (now) => (now instanceof Date ? now.getTime() : typeof now === "number" && Number.isFinite(now) ? now : Date.now());
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const amDate = (d) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
const standText = (d) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}. ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const round2 = (n) => Math.round(n * 100) / 100;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function newId(len = 8) {
  try {
    const a = new Uint8Array(Math.ceil(len / 2));
    globalThis.crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
  } catch {
    let s = "";
    while (s.length < len) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/** Number from a number or a German/English numeric string („1.200,50“, „2,5“, „-300“, „20 €“). */
function parseAmount(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.replace(/[€$\s]|eur(o)?|usd/gi, "");
  if (!s) return null;
  if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- private: settings validation

function coerceSetting(key, value, current) {
  const def = DEFAULT_SETTINGS[key];
  if (key === "closingPhrase") {
    if (value === null) return null;
    if (value === undefined) return current;
    return String(value).trim().slice(0, STRING_MAX.closingPhrase);
  }
  if (typeof def === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === 1 || value === "1" || value === "on") return true;
    if (value === "false" || value === 0 || value === "0" || value === "off" || value === "") return false;
    return current;
  }
  if (typeof def === "number") {
    let n = typeof value === "number" ? value : parseAmount(String(value ?? ""));
    if (n === null || !Number.isFinite(n)) return current;
    const lim = LIMITS[key];
    if (lim) n = Math.min(lim[1], Math.max(lim[0], n));
    if (INT_KEYS.has(key)) n = Math.round(n);
    return n;
  }
  if (typeof def === "string") {
    if (value === null || value === undefined) return current;
    const s = String(value).trim();
    if (key === "voicePreset") return PRESET_KEYS.has(s) ? s : current;
    if (key === "brainProvider") return PROVIDERS.has(s) ? s : current;
    if (key === "theme") return THEMES.has(s) ? s : current;
    if (key === "azureRegion") return REGIONS.has(s) ? s : current;
    return s.slice(0, STRING_MAX[key] ?? 200);
  }
  return current;
}

// Rechner ohne Touch: „Bildschirm wach halten“ ist dort standardmäßig aus (Bildschirmschoner und Sperre sollen greifen).
function desktopLike() {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function" || typeof navigator === "undefined") return false;
    const ua = String(navigator.userAgent || "");
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints || 0) > 0) return false;
    return window.matchMedia("(pointer: fine)").matches && !window.matchMedia("(any-pointer: coarse)").matches;
  } catch { return false; }
}

function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (desktopLike()) out.keepAwake = false;
  if (isObj(raw)) {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key === "v" || !(key in raw)) continue;
      out[key] = coerceSetting(key, raw[key], out[key]);
    }
  }
  freeVoice(out);
  out.v = VERSION;
  return Object.freeze(out);
}

/** CR1.2: an Azure preset without an Azure key is the free device voice (older builds stored "butler"). */
function freeVoice(s) {
  if (s.voicePreset !== FREE_PRESET && !String(s.azureKey || "").trim()) s.voicePreset = FREE_PRESET;
  return s;
}

// ---------------------------------------------------------------- private: loading and migration

function loadFacts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const n of raw) {
    if (!isObj(n)) continue;
    const text = collapse(n.text).slice(0, MAX.factChars);
    if (!text) continue;
    out.push({ id: typeof n.id === "string" && n.id ? n.id : newId(), text, am: typeof n.am === "string" ? n.am : "" });
  }
  return out.slice(-MAX.facts);
}

function loadShortcuts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!isObj(s) || typeof s.phrase !== "string" || !s.phrase || !Array.isArray(s.actions)) continue;
    const actions = s.actions.filter((a) => isObj(a) && SHORTCUT_ACTIONS.has(a.type));
    if (!actions.length) continue;
    out.push({ phrase: s.phrase, actions, at: Number(s.at) || 0 });
  }
  return out.slice(0, MAX.shortcuts);
}

function loadTimers(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    if (!isObj(t)) continue;
    const ends = Number(t.ends);
    if (!Number.isFinite(ends)) continue;
    out.push({
      id: typeof t.id === "string" && t.id ? t.id : newId(),
      label: String(t.label ?? "").slice(0, 30),
      ends,
      created: Number.isFinite(Number(t.created)) ? Number(t.created) : ends - 1,
      seconds: Number.isFinite(Number(t.seconds)) ? Number(t.seconds) : 0,
    });
  }
  return out.sort((a, b) => a.ends - b.ends).slice(-MAX.timers);
}

function loadHistory(raw) {
  const msgs = isObj(raw) && Array.isArray(raw.messages) ? raw.messages : [];
  const messages = msgs
    .filter((m) => isObj(m) && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  trimHistory(messages);
  return { v: 1, updated: messages.length ? Number(raw.updated) || 0 : 0, messages, webSeen: isObj(raw) && raw.webSeen === true };
}

/** Kopf der Notizen (notesPrompt), die vor der ersten Nachricht eines Gesprächs stehen. */
const NOTES_HEAD = "[Das hat ";

// Ältere Paare fallen vorne weg; die erste Nachricht mit den Notizen bleibt stehen (sonst vergisst das Gehirn nach
// 12 Fragen, was er ihm beigebracht hat – am Mac bleiben sie die ganze Sitzung, api-1).
function trimHistory(msgs) {
  const pin = msgs.length > 2 && msgs[0].role === "user" && msgs[0].content.startsWith(NOTES_HEAD) ? 2 : 0;
  while (msgs.length > MAX.history) msgs.splice(pin, 2);
}

function loadLog(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => isObj(e) && typeof e.text === "string")
    .map((e) => ({ kind: LOG_KINDS.has(e.kind) ? e.kind : "system", text: e.text, at: Number(e.at) || 0 }))
    .slice(-MAX.log);
}

function loadUsage(raw) {
  if (!isObj(raw)) return { day: "", input: 0, output: 0, requests: 0 };
  return { day: String(raw.day || ""), input: Number(raw.input) || 0, output: Number(raw.output) || 0,
    requests: Number(raw.requests) || 0 };
}

function loadMeta(raw) {
  const m = isObj(raw) ? raw : {};
  return { installedAt: Number(m.installedAt) || 0, lastBoot: Number(m.lastBoot) || 0,
    lastImportT: Number(m.lastImportT) || 0, migratedFromV1: Number(m.migratedFromV1) || 0 };
}

/** §8.5 – v1 settings and timers of the first phone PWA, once. */
function migrateV1(hadV2Settings) {
  const rawSettings = rawGet(LEGACY_KEYS.settings);
  const rawTimers = rawGet(LEGACY_KEYS.timers);
  if (rawSettings == null && rawTimers == null) return false;
  if (rawSettings != null) {
    let v1 = null;
    try { v1 = JSON.parse(rawSettings); } catch { v1 = null; }
    if (isObj(v1)) {
      const map = { anthropicKey: v1.anthropicKey, azureKey: v1.azureKey, azureRegion: v1.azureRegion,
        voicePreset: v1.preset, vorname: v1.name, firma: v1.company, gedaechtnis: v1.memory,
        wakeWord: v1.wakeOnStart, focus: v1.focus };
      const patch = {};
      for (const [k, v] of Object.entries(map)) {
        if (v === undefined || v === null) continue;
        // a v2 value that was already changed wins over the old v1 value
        if (hadV2Settings && state.settings[k] !== DEFAULT_SETTINGS[k]) continue;
        patch[k] = v;
      }
      state.settings = sanitizeSettings({ ...state.settings, ...patch });
      writeJSON(KEYS.settings, state.settings);
    }
  }
  if (rawTimers != null) {
    let list = null;
    try { list = JSON.parse(rawTimers); } catch { list = null; }
    if (Array.isArray(list)) {
      const known = new Set(state.timers.map((t) => t.id));
      for (const t of list) {
        if (!isObj(t) || !Number.isFinite(Number(t.ends))) continue;
        const id = typeof t.id === "string" && t.id ? t.id : newId();
        if (known.has(id)) continue;
        const ends = Number(t.ends);
        state.timers.push({ id, label: String(t.label ?? "").slice(0, 30), ends, created: ends - 1, seconds: 0 });
      }
      state.timers = loadTimers(state.timers);
      writeJSON(KEYS.timers, state.timers);
    }
  }
  removeKey(LEGACY_KEYS.settings);
  removeKey(LEGACY_KEYS.timers);
  state.meta.migratedFromV1 = Date.now();
  return true;
}

// ---------------------------------------------------------------- lifecycle and settings

/**
 * Load everything, migrate v1 once (§8.5), call navigator.storage.persist().
 * @returns {{ storage: "local"|"memory", migrated: boolean }}
 */
export function init() {
  backend = probeStorage();
  storageMode = backend ? "local" : "memory";
  const rawSettings = rawGet(KEYS.settings);
  const hadV2 = rawSettings != null;
  state.settings = sanitizeSettings(readJSON(KEYS.settings, {}));
  state.facts = loadFacts(readJSON(KEYS.facts, []));
  state.shortcuts = loadShortcuts(readJSON(KEYS.shortcuts, []));
  state.konto = normKonto(readJSON(KEYS.konto, null));
  state.timers = loadTimers(readJSON(KEYS.timers, []));
  state.history = loadHistory(readJSON(KEYS.history, null));
  state.log = loadLog(readJSON(KEYS.log, []));
  state.usage = loadUsage(readJSON(KEYS.usage, null));
  state.meta = loadMeta(readJSON(KEYS.meta, null));
  ready = true;
  let migrated = false;
  try { migrated = migrateV1(hadV2); } catch { migrated = false; }
  const now = Date.now();
  if (!state.meta.installedAt) state.meta.installedAt = now;
  state.meta.lastBoot = now;
  writeJSON(KEYS.meta, state.meta);
  try {
    const p = globalThis.navigator?.storage?.persist?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch { /* not supported */ }
  if (!storageListening && typeof globalThis.addEventListener === "function") {
    storageListening = true;
    globalThis.addEventListener("storage", onStorage);
  }
  return { storage: storageMode, migrated };
}

// Zweites Fenster derselben Seite (installierte App + Browser-Tab, zwei Tabs): was dort gespeichert wird, gilt hier
// sofort auch. Sonst schreibt dieses Fenster beim nächsten Speichern seinen alten Stand zurück und löscht z. B. den
// gerade eingetragenen Schlüssel (robustness-7).
let storageListening = false;
function onStorage(e) {
  if (!e || !ready) return;
  try { if (e.storageArea && backend && e.storageArea !== backend) return; } catch { /* ignore */ }
  const key = e.key;
  if (key === null) {                                   // localStorage.clear() im anderen Fenster
    for (const k of Object.values(KEYS)) reloadKey(k, rawGet(k));
    return;
  }
  if (!String(key).startsWith("jarvis.v2.")) return;
  reloadKey(key, e.newValue);
}

function reloadKey(key, raw) {
  if (raw === null || raw === undefined) mem.delete(key);
  else mem.set(key, raw);
  const val = (fallback) => {
    if (raw === null || raw === undefined) return fallback;
    try {
      const v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  };
  switch (key) {
    case KEYS.settings: state.settings = sanitizeSettings(val({})); emit("settings", state.settings); break;
    case KEYS.facts: state.facts = loadFacts(val([])); emit("facts", facts()); break;
    case KEYS.shortcuts: state.shortcuts = loadShortcuts(val([])); emit("shortcuts", shortcuts()); break;
    case KEYS.konto: state.konto = normKonto(val(null)); emit("konto", konto()); break;
    case KEYS.timers: state.timers = loadTimers(val([])); emit("timers", timers()); break;
    case KEYS.history: state.history = loadHistory(val(null)); emit("history", chatHistory()); break;
    case KEYS.log: state.log = loadLog(val([])); emit("log", logEntries()); break;
    case KEYS.usage: state.usage = loadUsage(val(null)); emit("usage", usageToday()); break;
    case KEYS.meta: state.meta = loadMeta(val(null)); break;
    default: break;
  }
}

/** @returns {Settings} frozen snapshot; a new object after every change */
export function settings() {
  ensure();
  return state.settings;
}

/**
 * Merge a patch: clamp numbers to LIMITS, validate enums, trim/limit strings, drop unknown keys, persist,
 * emit "settings".
 * @param {Partial<Settings>} patch
 * @returns {{ settings: Settings, changed: string[] }}
 */
export function setSettings(patch) {
  ensure();
  const changed = [];
  if (!isObj(patch)) return { settings: state.settings, changed };
  const next = { ...state.settings };
  for (const key of Object.keys(patch)) {
    if (key === "v" || !(key in DEFAULT_SETTINGS)) continue;
    const value = coerceSetting(key, patch[key], next[key]);
    if (value !== next[key]) {
      next[key] = value;
      changed.push(key);
    }
  }
  freeVoice(next);
  const vi = changed.indexOf("voicePreset");
  const voiceDiffers = next.voicePreset !== state.settings.voicePreset;
  if (voiceDiffers && vi < 0) changed.push("voicePreset");
  if (!voiceDiffers && vi >= 0) changed.splice(vi, 1);
  if (changed.length) {
    state.settings = Object.freeze(next);
    writeJSON(KEYS.settings, state.settings);
    emit("settings", state.settings);
  }
  return { settings: state.settings, changed };
}

/** @returns {string} settings().anrede.trim() || "Boss" */
export function anrede() {
  return String(settings().anrede || "").trim() || "Boss";
}

/** @returns {string} null → `${anrede()}, kann ich sonst noch was für Sie tun?`; "" → "" */
export function closingPhrase() {
  const c = settings().closingPhrase;
  if (c === null || c === undefined) return `${anrede()}, kann ich sonst noch was für Sie tun?`;
  return String(c).trim();
}

/**
 * Subscribe to changes. fn receives the topic's current value: settings → Settings snapshot, facts/shortcuts/
 * timers/history/log → the full list, konto → object|null, usage → usageToday().
 * @param {"settings"|"facts"|"shortcuts"|"konto"|"timers"|"history"|"log"|"usage"} topic
 * @param {(value: any) => void} fn
 * @returns {() => void} unsubscribe
 */
export function on(topic, fn) {
  const set = listeners.get(topic);
  if (!set || typeof fn !== "function") return () => {};
  set.add(fn);
  return () => set.delete(fn);
}

// ---------------------------------------------------------------- notes („merk dir …“, Mac data/gelernt.json)

function saveFacts() {
  writeJSON(KEYS.facts, state.facts);
  emit("facts", facts());
}

/** @returns {{ id: string, text: string, am: string }[]} am = "dd.mm.yyyy" (Mac field) */
export function facts() {
  ensure();
  return state.facts.map((n) => ({ ...n }));
}

/**
 * Port of Mac remember_note (live jarvis.py L1978-1987).
 * @param {string} text
 * @param {number} [now]
 * @returns {string} "" on success, else „Was soll ich mir merken?“
 */
export function addFact(text, now) {
  ensure();
  const t = collapse(text).slice(0, MAX.factChars);
  if (t.length < 3) return "Was soll ich mir merken?";
  const low = t.toLowerCase();
  const items = state.facts.filter((n) => n.text.toLowerCase() !== low).slice(-(MAX.facts - 1));
  items.push({ id: newId(), text: t, am: amDate(toDate(now)) });
  state.facts = items;
  saveFacts();
  return "";
}

/** Mac forget_note norm: lower case, non-word → space, collapse. */
function noteNorm(x) {
  return String(x ?? "").toLowerCase().replace(new RegExp(`[^${WORD}\\s]`, "gu"), " ").replace(/\s+/g, " ").trim();
}

/**
 * Port of Mac forget_note (live jarvis.py L1990-2005): exact normalised match, else substring match.
 * @param {string} text
 * @returns {string} "" on success, else „Was soll ich vergessen?“ / „Dazu habe ich mir nichts gemerkt.“ /
 *          „Dazu habe ich mehrere Sachen gemerkt: „a“ oder „b“ oder „c“. Welche soll ich vergessen?“
 */
export function forgetFact(text) {
  ensure();
  const want = noteNorm(text);
  const items = state.facts;
  if (!want) return "Was soll ich vergessen?";
  let hits = items.filter((n) => noteNorm(n.text) === want);
  if (!hits.length) hits = items.filter((n) => noteNorm(n.text).includes(want));
  if (!hits.length) return "Dazu habe ich mir nichts gemerkt.";
  if (hits.length > 1) {
    return "Dazu habe ich mehrere Sachen gemerkt: " + hits.slice(0, 3).map((n) => `„${n.text}“`).join(" oder ")
      + ". Welche soll ich vergessen?";
  }
  state.facts = items.filter((n) => n !== hits[0]);
  saveFacts();
  return "";
}

/**
 * Data sheet ✕.
 * @param {string} id
 * @returns {boolean} removed
 */
export function removeFact(id) {
  ensure();
  const before = state.facts.length;
  state.facts = state.facts.filter((n) => n.id !== id);
  if (state.facts.length === before) return false;
  saveFacts();
  return true;
}

/** @returns {void} */
export function clearFacts() {
  ensure();
  state.facts = [];
  saveFacts();
}

/**
 * Port of Mac notes_prompt (live jarvis.py L2008-2012), sent once per conversation in front of the first message.
 * @returns {string} "" or `[Das hat ${WER} dir beigebracht, es gilt immer: a | b | …]\n`
 */
export function notesPrompt() {
  ensure();
  if (!state.facts.length) return "";
  const wer = String(state.settings.vorname || "").trim() || "dein Nutzer";
  return `[Das hat ${wer} dir beigebracht, es gilt immer: `
    + state.facts.slice(-MAX.notesInPrompt).map((n) => n.text).join(" | ") + "]\n";
}

/** @returns {string} settings().gedaechtnis.trim() or "(noch leer)" (dynamic system context, §6.3) */
export function memoryForPrompt() {
  return String(settings().gedaechtnis || "").trim() || "(noch leer)";
}

// ---------------------------------------------------------------- learned voice shortcuts

const PHRASE_HEAD = new RegExp(`^(?:hey |hallo )?jarvis(?![${WORD}]) ?`, "u");
const PHRASE_TAIL = new RegExp(` ?(?<![${WORD}])(?:jarvis|boss|bitte)$`, "u");

/**
 * Port of Mac norm_phrase (jarvis.py L1694-1697).
 * @param {string} text
 * @returns {string}
 */
export function normPhrase(text) {
  let t = String(text ?? "").toLowerCase().replace(new RegExp(`[^${WORD}äöüß\\s]`, "gu"), " ")
    .replace(/\s+/g, " ").trim();
  t = t.replace(PHRASE_HEAD, "");
  return t.replace(PHRASE_TAIL, "").trim();
}

function saveShortcuts() {
  writeJSON(KEYS.shortcuts, state.shortcuts);
  emit("shortcuts", shortcuts());
}

function cleanShortcutActions(actions) {
  const clean = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!isObj(a) || !SHORTCUT_ACTIONS.has(a.type)) continue;
    const c = {};
    for (const [k, v] of Object.entries(a)) if (!String(k).startsWith("_")) c[k] = v;
    clean.push(c);
  }
  return clean;
}

/** @returns {{ phrase: string, actions: Action[], at: number }[]} */
export function shortcuts() {
  ensure();
  return state.shortcuts.map((s) => ({ phrase: s.phrase, actions: clone(s.actions), at: s.at }));
}

/**
 * @param {string} text
 * @returns {{ phrase: string, actions: Action[] } | null} match when normPhrase(text) === phrase
 */
export function findShortcut(text) {
  ensure();
  const p = normPhrase(text);
  if (!p) return null;
  const s = state.shortcuts.find((x) => x.phrase === p);
  return s ? { phrase: s.phrase, actions: clone(s.actions) } : null;
}

/**
 * Port of Mac learn_shortcut (jarvis.py L1700-1713); actions limited to SHORTCUT_ACTIONS, ≤ 6, phrase ≤ 60.
 * @param {string} phrase
 * @param {Action[]} actions
 * @param {number} [now]
 * @returns {string} "" on success, else the German error sentence
 */
export function learnShortcut(phrase, actions, now) {
  ensure();
  const p = normPhrase(phrase);
  const clean = cleanShortcutActions(actions);
  if (!p || p.length > 60 || !clean.length || clean.length > 6) return "Den Kurzbefehl kann ich so nicht anlernen.";
  const items = state.shortcuts.filter((s) => s.phrase !== p).slice(0, MAX.shortcuts - 1);
  items.push({ phrase: p, actions: clean, at: nowMs(now) });
  state.shortcuts = items;
  saveShortcuts();
  return "";
}

/**
 * @param {string} phrase
 * @returns {string} "" on success, else „Einen Kurzbefehl „…“ kenne ich nicht.“
 */
export function forgetShortcut(phrase) {
  ensure();
  const p = normPhrase(phrase);
  const rest = state.shortcuts.filter((s) => s.phrase !== p);
  if (rest.length === state.shortcuts.length) return `Einen Kurzbefehl „${p}“ kenne ich nicht.`;
  state.shortcuts = rest;
  saveShortcuts();
  return "";
}

// ---------------------------------------------------------------- konto + termine (Mac einnahmen.json shape, §8.3)

const KONTO_NUM = ["kontostand", "heute", "zahlungen_heute", "ziel_monat"];
const KONTO_ARR = ["verlauf", "quellen", "krypto", "konten", "termine", "hinweise", "buchungen"];
const KONTO_STR = ["stand", "tag", "monat", "waehrung"];
const WANN_RX = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;

function parseWann(wann) {
  const m = WANN_RX.exec(String(wann ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hasTime = m[4] !== undefined;
  const h = hasTime ? Number(m[4]) : 0;
  const mi = hasTime ? Number(m[5]) : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return { date, allDay: !hasTime, wann: hasTime ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}` };
}

function normTermin(t) {
  if (!isObj(t)) return null;
  const titel = collapse(t.titel ?? t.title).slice(0, 80);
  const w = parseWann(t.wann);
  if (!titel || !w) return null;
  return { ...t, id: typeof t.id === "string" && t.id ? t.id : newId(), wann: w.wann, titel,
    ort: collapse(t.ort).slice(0, 80) };
}

function sortTermine(list) {
  return list.sort((a, b) => (parseWann(a.wann)?.date ?? 0) - (parseWann(b.wann)?.date ?? 0));
}

/** Validate a konto object (pasted Mac einnahmen.json): known fields typed, unknown keys kept. */
function normKonto(raw) {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!isObj(raw)) return null;
  const k = clone(raw);
  for (const f of KONTO_NUM) {
    if (k[f] === undefined || k[f] === null) continue;
    const n = parseAmount(typeof k[f] === "number" ? k[f] : String(k[f]));
    if (n === null) return null;
    k[f] = n;
  }
  if (k.kontostand_vortag !== undefined && k.kontostand_vortag !== null) {
    const n = parseAmount(typeof k.kontostand_vortag === "number" ? k.kontostand_vortag : String(k.kontostand_vortag));
    if (n === null) return null;
    k.kontostand_vortag = n;
  }
  for (const f of KONTO_ARR) {
    if (k[f] === undefined || k[f] === null) continue;
    if (!Array.isArray(k[f])) return null;
  }
  for (const f of KONTO_STR) {
    if (k[f] === undefined || k[f] === null) continue;
    if (typeof k[f] !== "string") return null;
  }
  if (Array.isArray(k.verlauf)) k.verlauf = k.verlauf.map(Number).filter(Number.isFinite).slice(-MAX.verlauf);
  if (Array.isArray(k.quellen)) k.quellen = k.quellen.filter(isObj);
  if (Array.isArray(k.krypto)) k.krypto = k.krypto.filter(isObj);
  if (Array.isArray(k.konten)) k.konten = k.konten.filter(isObj);
  if (Array.isArray(k.buchungen)) k.buchungen = k.buchungen.filter(isObj).slice(-MAX.buchungen);
  if (Array.isArray(k.termine)) k.termine = sortTermine(k.termine.map(normTermin).filter(Boolean)).slice(-MAX.termine);
  return k;
}

// Ohne genannte Zahlen bleiben die Geldfelder leer (null): ein Termin allein erfindet keinen Kontostand 0,00 €.
function emptyKonto(d) {
  return { stand: standText(d), kontostand: null, kontostand_vortag: null, verlauf: [], heute: 0, zahlungen_heute: 0,
    tag: dayKey(d), monat: monthKey(d), ziel_monat: 0, quellen: [], krypto: [], konten: [], waehrung: "EUR",
    termine: [], hinweise: [], buchungen: [] };
}

/** heute/zahlungen reset when tag changes, quellen[].monat reset when monat changes (§8.3). */
function rollKonto(k, d) {
  const tag = dayKey(d);
  const monat = monthKey(d);
  if (k.tag !== tag) {
    k.heute = 0;
    k.zahlungen_heute = 0;
    k.tag = tag;
  }
  if (k.monat !== monat) {
    for (const q of Array.isArray(k.quellen) ? k.quellen : []) q.monat = 0;
    k.monat = monat;
  }
}

function saveKonto() {
  if (state.konto) writeJSON(KEYS.konto, state.konto);
  else removeKey(KEYS.konto);
  emit("konto", konto());
}

function workingKonto(d) {
  return state.konto ? clone(state.konto) : emptyKonto(d);
}

/**
 * Enthält das Konto echte Geldangaben (Kontostand, Quellen, Konten, Krypto, Buchungen, Ziel)? Nur Termine: nein.
 * @param {object|null} k
 * @returns {boolean}
 */
export function kontoHasMoney(k) {
  if (!isObj(k)) return false;
  const n = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  const list = (v) => Array.isArray(v) && v.length > 0;
  return n(k.kontostand) || list(k.quellen) || list(k.konten) || list(k.krypto) || list(k.buchungen)
    || (n(k.ziel_monat) && Number(k.ziel_monat) > 0) || (n(k.heute) && Number(k.heute) !== 0);
}

/** @returns {object|null} */
export function konto() {
  ensure();
  return clone(state.konto);
}

/**
 * Replace the konto object (pasted Mac einnahmen.json) or clear it with null.
 * @param {object|null} obj
 * @returns {string} "" or „Das Konto-JSON verstehe ich nicht.“
 */
export function setKonto(obj) {
  ensure();
  if (obj === null || obj === undefined || (typeof obj === "string" && !obj.trim())) {
    state.konto = null;
    saveKonto();
    return "";
  }
  const k = normKonto(obj);
  if (!k) return "Das Konto-JSON verstehe ich nicht.";
  state.konto = k;
  saveKonto();
  return "";
}

/**
 * Roll tag/monat, add to heute/quelle, push buchung. Does not change kontostand (§8.3).
 * @param {{ betrag: number|string, quelle?: string, text?: string }} entry
 * @param {number} [now]
 * @returns {string} "" or error sentence
 */
export function applyEinnahme(entry, now) {
  ensure();
  const e = isObj(entry) ? entry : {};
  const betrag = parseAmount(e.betrag);
  if (betrag === null || !(betrag > 0)) return "Den Betrag verstehe ich nicht.";
  const d = toDate(now);
  const k = workingKonto(d);
  rollKonto(k, d);
  const quelle = collapse(e.quelle).slice(0, 40) || "Sonstiges";
  const text = collapse(e.text).slice(0, 80);
  k.heute = round2((Number(k.heute) || 0) + betrag);
  k.zahlungen_heute = (Number(k.zahlungen_heute) || 0) + 1;
  if (!Array.isArray(k.quellen)) k.quellen = [];
  let q = k.quellen.find((x) => String(x.name || "").toLowerCase() === quelle.toLowerCase());
  if (!q) {
    q = { name: quelle, monat: 0, gesamt: 0 };
    k.quellen.push(q);
  }
  q.monat = round2((Number(q.monat) || 0) + betrag);
  q.gesamt = round2((Number(q.gesamt) || 0) + betrag);
  if (!Array.isArray(k.buchungen)) k.buchungen = [];
  k.buchungen.push({ id: newId(), at: d.getTime(), betrag: round2(betrag), quelle, text });
  k.buchungen = k.buchungen.slice(-MAX.buchungen);
  k.stand = standText(d);
  state.konto = k;
  saveKonto();
  return "";
}

/**
 * @param {number|string} betrag may be negative
 * @param {number} [now]
 * @returns {string} "" or error sentence
 */
export function setKontostand(betrag, now) {
  ensure();
  const n = parseAmount(betrag);
  if (n === null) return "Den Betrag verstehe ich nicht.";
  const d = toDate(now);
  const today = dayKey(d);
  const k = workingKonto(d);
  const lastDay = typeof k.kontostand_tag === "string" ? k.kontostand_tag : typeof k.tag === "string" ? k.tag : "";
  if (state.konto && lastDay && lastDay < today && Number.isFinite(Number(k.kontostand))) {
    k.kontostand_vortag = Number(k.kontostand);
  }
  rollKonto(k, d);
  k.kontostand = round2(n);
  k.kontostand_tag = today;
  if (!Array.isArray(k.verlauf)) k.verlauf = [];
  k.verlauf.push(round2(n));
  k.verlauf = k.verlauf.slice(-MAX.verlauf);
  k.stand = standText(d);
  state.konto = k;
  saveKonto();
  return "";
}

/** @returns {{ id: string, wann: string, titel: string, ort: string }[]} */
export function termine() {
  ensure();
  const list = state.konto && Array.isArray(state.konto.termine) ? state.konto.termine : [];
  return sortTermine(list.map((t) => ({ ...t })));
}

/**
 * @param {{ titel: string, wann: string, ort?: string }} termin wann = "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"
 * @param {number} [now]
 * @returns {string} "" or error sentence
 */
export function addTermin(termin, now) {
  ensure();
  const t = normTermin(isObj(termin) ? { titel: termin.titel ?? termin.title, wann: termin.wann, ort: termin.ort } : null);
  if (!t) return "Den Termin verstehe ich nicht.";
  const d = toDate(now);
  const k = workingKonto(d);
  if (!Array.isArray(k.termine)) k.termine = [];
  k.termine = k.termine.filter((x) => !(x.wann === t.wann && String(x.titel).toLowerCase() === t.titel.toLowerCase()));
  k.termine.push({ id: t.id, wann: t.wann, titel: t.titel, ort: t.ort });
  k.termine = sortTermine(k.termine).slice(-MAX.termine);
  state.konto = k;
  saveKonto();
  return "";
}

/**
 * @param {{ id?: string, titel?: string, wann?: string }} query
 * @returns {number} count removed
 */
export function removeTermin(query) {
  ensure();
  if (!state.konto || !Array.isArray(state.konto.termine) || !isObj(query)) return 0;
  const id = typeof query.id === "string" ? query.id : "";
  const titel = noteNorm(query.titel ?? query.title);
  const wannRaw = String(query.wann ?? "").trim();
  const w = parseWann(wannRaw);
  const wann = w ? w.wann : wannRaw.slice(0, 16);
  if (!id && !titel && !wann) return 0;
  const match = (t) => {
    if (id) return t.id === id;
    if (titel) {
      const tt = noteNorm(t.titel);
      if (!(tt === titel || tt.includes(titel) || titel.includes(tt))) return false;
    }
    if (wann) {
      const allDayQuery = w ? w.allDay : !wann.includes("T");
      if (allDayQuery ? !String(t.wann).startsWith(wann.slice(0, 10)) : String(t.wann) !== wann) return false;
    }
    return true;
  };
  const before = state.konto.termine.length;
  const k = clone(state.konto);
  k.termine = k.termine.filter((t) => !match(t));
  const removed = before - k.termine.length;
  if (removed) {
    state.konto = k;
    saveKonto();
  }
  return removed;
}

/**
 * Termine from the start of today until today + days (all-day ones count for their whole day), sorted.
 * @param {Date|number} now
 * @param {number} [days=14]
 * @returns {object[]}
 */
export function upcomingTermine(now, days = 14) {
  const d = toDate(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + Math.max(0, Number(days) || 0)).getTime();
  return termine()
    .map((t) => ({ t, p: parseWann(t.wann) }))
    .filter(({ p }) => p && p.date.getTime() >= start && p.date.getTime() < end)
    .sort((a, b) => a.p.date - b.p.date)
    .map(({ t, p }) => ({ ...t, allDay: p.allDay, at: p.date.getTime() }));
}

// ---------------------------------------------------------------- timers (absolute end times, survive reload)

function saveTimers() {
  writeJSON(KEYS.timers, state.timers);
  emit("timers", timers());
}

/** @returns {Timer[]} sorted by ends */
export function timers() {
  ensure();
  return state.timers.map((t) => ({ ...t })).sort((a, b) => a.ends - b.ends);
}

/**
 * @param {number} seconds clamped 1..86400
 * @param {string} label ≤ 30 chars
 * @param {number} [now]
 * @returns {Timer}
 */
export function addTimer(seconds, label, now) {
  ensure();
  const n = Number(seconds);
  const secs = Math.max(1, Math.min(Number.isFinite(n) ? Math.trunc(n) : 1, 24 * 3600));
  const created = nowMs(now);
  const t = { id: newId(), label: collapse(label).slice(0, 30), ends: created + secs * 1000, created, seconds: secs };
  state.timers.push(t);
  if (state.timers.length > MAX.timers) {
    state.timers.sort((a, b) => a.created - b.created);
    state.timers = state.timers.slice(-MAX.timers);
  }
  state.timers.sort((a, b) => a.ends - b.ends);
  saveTimers();
  return { ...t };
}

/**
 * @param {string} [labelOrId] none given → all
 * @returns {Timer[]} the cancelled timers
 */
export function cancelTimers(labelOrId) {
  ensure();
  const q = collapse(labelOrId).toLowerCase();
  let hit;
  if (!q) hit = state.timers.slice();
  else {
    hit = state.timers.filter((t) => t.id === labelOrId || t.label.toLowerCase() === q);
    if (!hit.length) hit = state.timers.filter((t) => t.label && (t.label.toLowerCase().includes(q) || q.includes(t.label.toLowerCase())));
  }
  if (!hit.length) return [];
  const ids = new Set(hit.map((t) => t.id));
  state.timers = state.timers.filter((t) => !ids.has(t.id));
  saveTimers();
  return hit.map((t) => ({ ...t })).sort((a, b) => a.ends - b.ends);
}

/**
 * Remove and return timers with ends <= now.
 * @param {number} now
 * @returns {Timer[]}
 */
export function takeDue(now) {
  ensure();
  const t = nowMs(now);
  const due = state.timers.filter((x) => x.ends <= t);
  if (!due.length) return [];
  state.timers = state.timers.filter((x) => x.ends > t);
  saveTimers();
  return due.map((x) => ({ ...x })).sort((a, b) => a.ends - b.ends);
}

// ---------------------------------------------------------------- chat history (text only)

function saveHistory() {
  writeJSON(KEYS.history, state.history);
  emit("history", chatHistory());
}

/** @returns {ChatMessage[]} */
export function chatHistory() {
  ensure();
  return state.history.messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Append one user/assistant pair; trim to MAX.history from the front in pairs.
 * @param {string} userContent
 * @param {string} assistantText
 * @param {number} [now]
 */
export function appendTurn(userContent, assistantText, now) {
  ensure();
  const msgs = state.history.messages.slice();
  msgs.push({ role: "user", content: String(userContent ?? "") }, { role: "assistant", content: String(assistantText ?? "") });
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  trimHistory(msgs);
  state.history = { v: 1, updated: nowMs(now), messages: msgs, webSeen: !!state.history.webSeen };
  saveHistory();
}

/** @returns {void} */
export function clearHistory() {
  ensure();
  state.history = { v: 1, updated: 0, messages: [], webSeen: false };
  saveHistory();
}

/**
 * Hat eine Antwort DIESES Gesprächs das Web benutzt (Mac web_seen, Lern-Sperre D18)? Liegt mit dem Gespräch im
 * Speicher, damit die Sperre ein Neuladen übersteht (security-privacy-4).
 * @returns {boolean}
 */
export function conversationWebSeen() {
  ensure();
  return !!state.history.webSeen;
}

/** @param {boolean} on */
export function setConversationWebSeen(on) {
  ensure();
  const v = !!on;
  if (!!state.history.webSeen === v) return;
  state.history = { ...state.history, webSeen: v };
  writeJSON(KEYS.history, state.history);
}

/** @returns {number} ms epoch of the last turn, 0 if none */
export function lastTurnAt() {
  ensure();
  return state.history.messages.length ? Number(state.history.updated) || 0 : 0;
}

// ---------------------------------------------------------------- protocol log

/** @returns {LogEntry[]} */
export function logEntries() {
  ensure();
  return state.log.map((e) => ({ ...e }));
}

/**
 * Keeps MAX.log entries.
 * @param {LogEntry["kind"]} kind
 * @param {string} text
 * @param {number} [now]
 * @returns {LogEntry}
 */
export function appendLog(kind, text, now) {
  ensure();
  const entry = { kind: LOG_KINDS.has(kind) ? kind : "system", text: String(text ?? ""), at: nowMs(now) };
  state.log = [...state.log, entry].slice(-MAX.log);
  writeJSON(KEYS.log, state.log);
  emit("log", logEntries());
  return { ...entry };
}

/** @returns {void} */
export function clearLog() {
  ensure();
  state.log = [];
  writeJSON(KEYS.log, state.log);
  emit("log", []);
}

// ---------------------------------------------------------------- usage

/**
 * @param {{ input: number, output: number }} usage
 * @param {number} [now]
 */
export function addUsage(usage, now) {
  ensure();
  const day = dayKey(toDate(now));
  const u = state.usage.day === day ? { ...state.usage } : { day, input: 0, output: 0, requests: 0 };
  u.input += Math.max(0, Number(usage?.input) || 0);
  u.output += Math.max(0, Number(usage?.output) || 0);
  u.requests += 1;
  state.usage = u;
  writeJSON(KEYS.usage, u);
  emit("usage", usageToday(now));
}

/**
 * @param {number} [now]
 * @returns {{ input: number, output: number, requests: number }}
 */
export function usageToday(now) {
  ensure();
  const day = dayKey(toDate(now));
  if (state.usage.day !== day) return { input: 0, output: 0, requests: 0 };
  return { input: state.usage.input, output: state.usage.output, requests: state.usage.requests };
}

// ---------------------------------------------------------------- Setup-Link (§8.4)

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(b64) {
  const s = String(b64).trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) throw new Error("cfg");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Payload { v: 1, t, s, f?, k? } → JSON → UTF-8 → base64url without padding.
 * @param {{ withKeys?: boolean, includeFacts?: boolean, includeShortcuts?: boolean }} [opts]
 * @returns {string}
 */
export function encodeSetup({ withKeys = true, includeFacts = true, includeShortcuts = true } = {}) {
  ensure();
  const s = { ...state.settings };
  delete s.v;
  if (!withKeys) {
    delete s.anthropicKey;
    delete s.geminiKey;
    delete s.azureKey;
  }
  const payload = { v: 1, t: Date.now(), s };
  if (includeFacts && state.facts.length) payload.f = state.facts.map((n) => n.text);
  if (includeShortcuts && state.shortcuts.length) payload.k = state.shortcuts.map((x) => ({ phrase: x.phrase, actions: clone(x.actions) }));
  return b64urlEncode(JSON.stringify(payload));
}

/**
 * @param {string} b64
 * @returns {object} payload
 * @throws {Error} Error("cfg") on bad input
 */
export function decodeSetup(b64) {
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(b64));
  } catch {
    throw new Error("cfg");
  }
  if (!isObj(payload) || payload.v !== 1 || !isObj(payload.s) || !Number.isFinite(Number(payload.t))) {
    throw new Error("cfg");
  }
  if (payload.f !== undefined && !Array.isArray(payload.f)) throw new Error("cfg");
  if (payload.k !== undefined && !Array.isArray(payload.k)) throw new Error("cfg");
  return payload;
}

function pageBase() {
  try {
    const loc = globalThis.location;
    return loc ? loc.origin + loc.pathname : "";
  } catch {
    return "";
  }
}

// Schlüssel reisen nie in einem Link: der landet im Browser-Verlauf (mit Sync auch im Google-/Microsoft-Konto).
// Für Schlüssel gibt es den Setup-Code zum Kopieren und Einfügen (security-privacy-3).
const KEY_FIELDS = Object.freeze(["anthropicKey", "geminiKey", "azureKey"]);
const CODE_HEAD = "JARVIS-SETUP:";

/**
 * Setup-Link `<base>#cfg=<b64>`; with wake: Kurzbefehl-Link `<base>?wake=1#cfg=<b64>`. Never contains keys.
 * @param {{ wake?: boolean, base?: string }} [opts] base defaults to location.origin + location.pathname
 * @returns {string}
 */
export function setupLink({ wake = false, base } = {}) {
  const b = typeof base === "string" ? base : pageBase();
  return `${b}${wake ? "?wake=1" : ""}#cfg=${encodeSetup({ withKeys: false })}`;
}

/**
 * Setup-Code `JARVIS-SETUP:<b64>` with the keys, for copy and paste (nothing lands in the browser history).
 * @returns {string}
 */
export function setupCode() {
  return CODE_HEAD + encodeSetup({ withKeys: true });
}

/**
 * Reads a pasted Setup-Code (also a whole Setup-Link or the bare base64 part).
 * @param {string} text
 * @returns {object} payload (not applied: applySetup() after the user said yes)
 * @throws {Error} Error("cfg") on bad input
 */
export function readSetupCode(text) {
  let t = String(text ?? "").replace(/\s+/g, "");
  if (!t) throw new Error("cfg");
  const m = /[#?&]cfg=([^&#]+)/.exec(t);
  if (m) t = m[1];
  else if (t.toUpperCase().startsWith(CODE_HEAD)) t = t.slice(CODE_HEAD.length);
  try { t = decodeURIComponent(t); } catch { /* plain base64url */ }
  return decodeSetup(t);
}

function withoutKeys(payload) {
  const s = { ...payload.s };
  for (const k of KEY_FIELDS) delete s[k];
  return { ...payload, s };
}

function applyImport(payload) {
  setSettings(payload.s);
  const today = amDate(new Date());
  if (Array.isArray(payload.f) && payload.f.length) {
    const known = new Set(state.facts.map((n) => noteNorm(n.text)));
    const items = state.facts.slice();
    for (const raw of payload.f) {
      const text = collapse(raw).slice(0, MAX.factChars);
      const key = noteNorm(text);
      if (text.length < 3 || !key || known.has(key)) continue;
      known.add(key);
      items.push({ id: newId(), text, am: today });
    }
    if (items.length !== state.facts.length) {
      state.facts = items.slice(-MAX.facts);
      saveFacts();
    }
  }
  if (Array.isArray(payload.k) && payload.k.length) {
    let items = state.shortcuts.slice();
    let changed = false;
    for (const s of payload.k) {
      if (!isObj(s)) continue;
      const phrase = normPhrase(s.phrase);
      const actions = cleanShortcutActions(s.actions);
      if (!phrase || phrase.length > 60 || !actions.length || actions.length > 6) continue;
      items = items.filter((x) => x.phrase !== phrase);
      items.push({ phrase, actions, at: Date.now() });
      changed = true;
    }
    if (changed) {
      state.shortcuts = items.slice(-MAX.shortcuts);
      saveShortcuts();
    }
  }
}

/**
 * Übernimmt einen Setup-Link, den der Nutzer bestätigt hat (security-privacy-1: nie still beim Öffnen).
 * @param {object} payload aus importFromLocation().pending / decodeSetup()
 * @returns {boolean}
 */
export function applySetup(payload) {
  ensure();
  if (!isObj(payload) || !isObj(payload.s)) return false;
  applyImport(payload);
  state.meta.lastImportT = Number(payload.t) || 0;
  writeJSON(KEYS.meta, state.meta);
  return true;
}

/**
 * Read `#cfg=` (once per payload.t) and `?wake=1`, always strip both from the URL (replaceState). The payload is NOT
 * applied here: the app asks first and then calls applySetup() (security-privacy-1).
 * @param {Location} [loc]
 * @param {History} [hist]
 * @returns {{ imported: boolean, wake: boolean, pending: object|null, error?: string }}
 */
export function importFromLocation(loc = globalThis.location, hist = globalThis.history) {
  const result = { imported: false, wake: false, pending: null };
  if (!loc) return result;
  const search = new URLSearchParams(String(loc.search || "").replace(/^\?/, ""));
  const hashParams = new URLSearchParams(String(loc.hash || "").replace(/^#/, ""));
  const wakeVal = search.has("wake") ? search.get("wake") : null;
  result.wake = wakeVal !== null && wakeVal !== "0" && wakeVal !== "false";
  const cfg = hashParams.get("cfg") ?? search.get("cfg");
  // zuerst die Adresse aufräumen, vor allem anderen (security-privacy-3)
  const strip = search.has("wake") || search.has("cfg") || hashParams.has("cfg");
  if (strip) {
    search.delete("wake");
    search.delete("cfg");
    hashParams.delete("cfg");
    const qs = search.toString();
    const hs = hashParams.toString();
    try {
      hist?.replaceState?.(hist.state ?? null, "", (loc.pathname || "/") + (qs ? "?" + qs : "") + (hs ? "#" + hs : ""));
    } catch { /* ignore */ }
  }
  ensure();
  if (cfg) {
    try {
      // ein Link bringt nie Schlüssel mit, auch kein fremder, selbst gebauter (security-privacy-1/-3)
      const payload = withoutKeys(decodeSetup(cfg));
      if (Number(payload.t) !== state.meta.lastImportT) result.pending = payload;
    } catch {
      result.error = "cfg";
    }
  }
  return result;
}

// ---------------------------------------------------------------- wipe

// Stimmen-Cache (voice.js, „jarvis-tts-…“): darin liegen gesprochene Sätze, auch persönliche („Dein Kontostand …“).
// „Alles löschen“ nimmt ihn mit (security-privacy-5); die App-Dateien im Cache sind nicht persönlich und bleiben.
let wiping = Promise.resolve();
function clearSpeechCaches() {
  try {
    const cs = globalThis.caches;
    if (!cs || typeof cs.keys !== "function") return Promise.resolve();
    return cs.keys()
      .then((keys) => Promise.all(keys.filter((k) => String(k).startsWith("jarvis-tts")).map((k) => cs.delete(k))))
      .then(() => undefined, () => undefined);
  } catch {
    return Promise.resolve();
  }
}

/** @returns {Promise<void>} resolves when the last wipe("all") has also emptied the speech cache */
export function wipeDone() {
  return wiping;
}

/**
 * @param {"all"|"keys"|"facts"|"shortcuts"|"konto"|"history"|"log"|"timers"} scope
 */
export function wipe(scope) {
  ensure();
  switch (scope) {
    case "all": {
      wiping = clearSpeechCaches();
      for (const key of Object.values(KEYS)) removeKey(key);
      for (const key of Object.values(LEGACY_KEYS)) removeKey(key);
      state = {
        settings: DEFAULT_SETTINGS, facts: [], shortcuts: [], konto: null, timers: [],
        history: { v: 1, updated: 0, messages: [], webSeen: false }, log: [], usage: { day: "", input: 0, output: 0, requests: 0 },
        meta: { installedAt: 0, lastBoot: 0, lastImportT: 0, migratedFromV1: 0 },
      };
      emit("settings", state.settings);
      emit("facts", []);
      emit("shortcuts", []);
      emit("konto", null);
      emit("timers", []);
      emit("history", []);
      emit("log", []);
      emit("usage", { input: 0, output: 0, requests: 0 });
      break;
    }
    case "keys":
      setSettings({ anthropicKey: "", geminiKey: "", azureKey: "" });
      break;
    case "facts":
      clearFacts();
      break;
    case "shortcuts":
      state.shortcuts = [];
      saveShortcuts();
      break;
    case "konto":
      setKonto(null);
      break;
    case "history":
      clearHistory();
      break;
    case "log":
      clearLog();
      break;
    case "timers":
      cancelTimers();
      break;
    default:
      break;
  }
}
