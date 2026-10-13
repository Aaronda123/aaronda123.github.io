// ==============================================================================================================
// CONTRACT – app.js (owner: builder CORE). Spec: ARCHITECTURE.md §3.2.11, §3.4, §4 (+ CHANGES-1 CR1-CR3).
// Entry module (index.html, type="module"). No exports. Imports:
//   store.js, intents.js, ears.js, voice.js, brain.js, tools.js, hud.js, sheets.js, awake.js
// Only app.js changes `state` (loading|idle|listening|transcribing|thinking|speaking|error) and
// `mode` (shown|hidden|stealth); it reflects them through hud.setState() and hud.setVisibility().
// Flows: boot incl. store.importFromLocation() for #cfg= / ?wake=1 (§4.2, no forced setup sheet: CR1); gesture unlock
// catcher on touchend/click (§4.3); wake word → overlay pops up, chime, the same recognition session continues as the
// command, bare name → "Ja, {A}?" + 4 s follow-up (§4.4, D4); listen / interrupt / resumeIdle with one recognizer at
// a time and no wake recognizer while thinking or speaking (§4.5, D5); handleText: intents.quickIntent → tools,
// else (brain configured) brain.ask streaming → voice.say sentence by sentence → tools.runAction for AKTION results
// (SAFE_AFTER_WEB and learn guard, D15/D18) → closing phrase (§4.6), else the free noBrain line with a ⚙ button (CR1.3);
// action results drive links, images, 3D models and the orb (applyResult); hidden / stealth modes close the model
// (§4.8); timers incl. the Mac 30-minute missed-timer rule, idle dim, auto-hide, visibility (§4.9); commands (§4.10);
// desktop keys Ctrl+Alt+Space / J / K and Escape (CR3); Android/browser Back closes sheets and the 3D model (history).
// Test hook (always on, contains no secrets):
//   window.__jarvis = { get state, get mode, get muted, get wake, get locked, spoken: [], heard: [],
//                       handle(text, { spoken }), listen(), stop(), stealth(), show(), version: "2.0.0" }
// ==============================================================================================================
// JARVIS: Steuerung. Zustände, Abläufe und Sätze wie am Mac (Controller in jarvis.py):
// BOOT → BEREIT → HÖRE ZU → (VERSTEHE) → DENKE NACH → SPRICHT → BEREIT; „Jarvis“ holt ihn jederzeit zurück.
import * as store from "./store.js";
import * as intents from "./intents.js";
import * as ears from "./ears.js";
import * as voice from "./voice.js";
import * as brain from "./brain.js";
import * as tools from "./tools.js";
import * as hud from "./hud.js";
import * as sheets from "./sheets.js";
import * as awake from "./awake.js";

const VERSION = "2.0.0";
const FOLLOW_UP_DELAY_MS = 350;            // Mac speak_done: 0,35 s Nachhall, dann zuhören
const BOOT_READY_MS = 900;
const BOOT_HIDE_MS = 600;
const TIMER_LATE_MS = 30000;               // bis 30 s zu spät: ganz normal ansagen
const TIMER_ALIVE_GAP_MS = 75000;          // Hintergrund-Tab (Chrome: 1 Weckruf pro Minute): Seite lief, kein „verpasst“
const TIMER_MISSED_MS = 30 * 60000;        // live Mac Timers.restore: bis 30 min nachträglich melden
const ANNOUNCE_POLL_MS = 500;
const ANNOUNCE_MAX_MS = 60000;
const LISTEN_ON_OPEN_MS = 2000;
const TICK_MS = 1000;
const TEST_TIMEOUT_MS = 15000;
const SETUP_HREF = "#jarvis-einstellungen";
const CLAUDE_KEY_RX = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const GEMINI_KEY_RX = /^[A-Za-z0-9_-]{30,}$/;
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];
const TIMING_KEYS = ["silenceSeconds", "hesitationSeconds", "maxRecordSeconds", "noSpeechSeconds", "followUpSeconds"];
const SAY_TYPES = new Set(["weather", "show_image", "next_image"]);
// „starting“ ist noch nicht „AKTIV“ (Browser ohne Erkennungsdienst blieben sonst ewig scheinbar aktiv, android-desktop-8)
const WAKE_LABEL = { on: "AKTIV", starting: "STARTET", off: "AUS", paused: "PAUSE", blocked: "GESPERRT",
  unsupported: "NICHT VERFÜGBAR", error: "PAUSE" };
const WAKE_RUNNING = new Set(["on", "starting", "paused"]);
const UNLOCK_KEYS_IGNORED = new Set(["Escape", "Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"]);
const OUTSIDE_WAKE_DEDUPE_MS = 1500;
// Maus statt Finger (Rechner): Hinweise sagen „anklicken“/„Doppelklick“ statt „antippen“/„zweimal tippen“ (visual-ux-13)
const MOUSE = (() => {
  try {
    return !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches
      && !window.matchMedia?.("(any-pointer: coarse)").matches;
  } catch { return false; }
})();
const TAP2 = MOUSE ? "Doppelklick" : "zweimal tippen";
const TYPE_DETAIL = MOUSE ? "Tipp deine Frage ein …" : "Tippen oder diktieren …";

// Setup-Link (#cfg=) und ?wake=1 gleich beim Laden lesen und aus der Adresse nehmen – vor allem anderen, damit der
// Link nicht in der Adresszeile, beim Teilen oder in wiederhergestellten Tabs stehen bleibt (security-privacy-3)
const BOOT_IMPORT = (() => {
  try { return store.importFromLocation() || { imported: false, wake: false, pending: null }; } catch (e) {
    console.error("setup link", e);
    return { imported: false, wake: false, pending: null, error: "cfg" };
  }
})();
const WAKE_PARAM = !!BOOT_IMPORT.wake;

// ---------------------------------------------------------------- Zustand (§4.1)
let state = "loading";
let mode = "shown";
let muted = false;
let turn = 0;
let locked = { audio: true, mic: true };
let listening = null;
let prehidden = false;
let lastAnswer = "";
let heardAt = 0;
let lastActivity = Date.now();
let turnAbort = new AbortController();
let pendingAfterUnlock = null;            // null | "greeting" | "wake" | "background" | "answer"
let bootReason = "normal";
let booted = false;
let expectSpeech = 0;                     // Runde, deren Sprache gerade erwartet wird
let inputFocused = false;
let hiddenAt = 0;
let dimmed = false;
let linkToastShown = false;
let unlockInstalled = false;
let unlocking = false;
let micDeniedLogged = false;
let noListenShown = false;
let lastLatency = null;
let lastSettings = null;
let gestureNow = false;                   // gerade synchron in einem Tippen (Mikrofon darf starten)
let announceChain = Promise.resolve();
let authBad = false;
let awakeCatcher = false;                 // Fänger nur fürs Wachhalten (Hintergrund-Start, ?wake=1), einmal pro Aufruf
let awakeCatcherShown = false;
let heardPartial = false;                 // im offenen Zuhören schon etwas verstanden (für das Tippen nach ?wake=1)
let lastTickAt = 0;
const PAGE_START = Date.now();            // diese Seite läuft seit … (Timer, die danach abliefen, liefen bei offener Seite ab)
let timerWake = 0;
let historyPushed = false;                // eigener Verlaufseintrag für ein offenes Blatt / 3D-Modell (Zurück-Taste)
let ignorePops = 0;
let serviceLogged = false;
let micUnlock = null;                     // Freischalt-Versuch des Mikrofons aus dem laufenden Tippen (robustness-1)
let micRetryFailed = false;               // im Tippen erneut verweigert: bis zur Rückkehr auf die Seite gleich die Tastatur
let wakeGen = 0;                          // ++ bei jedem Ein-/Ausschalten des Weckworts (robustness-2)
let imagePausedBy = null;                 // die Zuhör-Runde, die die Bild-Zeit angehalten hat (robustness-3)
let mutedTurn = 0;                        // Runde, die beim Wechsel in den Hintergrund lief: spricht nicht weiter (robustness-9)
let lastOutsideWake = 0;                  // Rückkehr + pageshow: nur ein „Ja, Boss?“ (robustness-12)
let importPending = null;                 // Setup-Link, der erst nach Bestätigung gilt (security-privacy-1)

const S = () => store.settings();
const A = () => store.anrede();
const L = (key, vars = {}) => intents.line(key, { A: A(), ...vars });
// Hinweis auf dem Bildschirm: am Rechner mit Maus „Klicken …“ statt „Tippen …“, sofern es die Variante gibt (visual-ux-13)
const LM = (key, vars = {}) => L(MOUSE && intents.LINES?.[`${key}Mouse`] != null ? `${key}Mouse` : key, vars);
const pad2 = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function report(where, err) {
  try { console.warn(`jarvis: ${where}`, err); } catch { /* ignore */ }
}

function safe(fn, fallback) {
  try { return fn(); } catch (e) { report("call", e); return fallback; }
}

function isStandalone() {
  try { if (navigator.standalone === true) return true; } catch { /* ignore */ }
  try { return !!window.matchMedia?.("(display-mode: standalone)").matches; } catch { return false; }
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent || "")
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Wie Jarvis das Gerät nennt (Sätze und Gehirn, CR3.1): iPhone, iPad, Handy oder Computer. */
function deviceNoun() {
  const ua = navigator.userAgent || "";
  if (isIOS()) return /iPhone|iPod/.test(ua) ? "iPhone" : "iPad";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Handy" : "Tablet";
  return "Computer";
}

// ---------------------------------------------------------------- Test-Hook (§11.2)
const hook = {
  get state() { return state; },
  get mode() { return mode; },
  get muted() { return muted; },
  get wake() { return safe(() => ears.wakeState(), "off"); },
  get locked() { return { ...locked }; },
  spoken: [],
  heard: [],
  handle(text, opts = { spoken: false }) { return submitText(String(text ?? ""), { spoken: !!opts?.spoken }); },
  listen() { listen(); },
  stop() { stopAll(); },
  stealth() { enterStealth(); },
  show() { leaveHidden({ pop: true }); resumeIdle(); },
  version: VERSION,
};
window.__jarvis = hook;

// ---------------------------------------------------------------- Protokoll
function log(kind, text) {
  const t = String(text ?? "").trim();
  if (!t) return;
  safe(() => hud.log(kind, t), null);
  safe(() => store.appendLog(kind, t), null);
}

// ---------------------------------------------------------------- Gehirn (Claude / Gemini, CR2)
function claudeOk(s) { return CLAUDE_KEY_RX.test(String(s?.anthropicKey ?? "").trim()); }
function geminiOk(s) { return GEMINI_KEY_RX.test(String(s?.geminiKey ?? "").trim()); }

function providerFor(s) {
  const pref = String(s?.brainProvider || "auto");
  if (pref === "claude") return claudeOk(s) ? "claude" : "none";
  if (pref === "gemini") return geminiOk(s) ? "gemini" : "none";
  return claudeOk(s) ? "claude" : geminiOk(s) ? "gemini" : "none";
}

/** Welches Gehirn denkt gerade? "claude" | "gemini" | "none". */
function provider() {
  if (typeof brain.provider === "function") {
    const p = safe(() => brain.provider(), null);
    if (p === "claude" || p === "gemini" || p === "none") return p;
    if (p === null || p === "" || p === false) return "none";
  }
  const p = providerFor(S());
  if (p === "gemini" && typeof brain.provider !== "function" && typeof brain.hasBrain !== "function") {
    return safe(() => brain.hasKey(), false) ? "claude" : "none";   // brain.js ohne Gemini: nur Claude denkt
  }
  return p;
}

function brainReady() {
  if (typeof brain.hasBrain === "function") return !!safe(() => brain.hasBrain(), false);
  return provider() !== "none";
}

function coreLabel() {
  const p = provider();
  return p === "gemini" ? "GEMINI · FLASH" : p === "claude" ? "CLAUDE · AUTO" : "KEIN GEHIRN";
}

function tierLabel(t) {
  const lab = String(t?.label ?? "");
  if (provider() === "gemini" || /gemini/i.test(lab)) return /gemini/i.test(lab) ? lab.toUpperCase() : "GEMINI · FLASH";
  return `CLAUDE · ${String(t?.level || "auto").toUpperCase()}`;
}

function updateStatus() {
  const p = provider();
  if (p === "none") hud.setAuth("KEIN GEHIRN", false);
  else if (authBad) hud.setAuth(`${p === "gemini" ? "GEMINI" : "CLAUDE"}: SCHLÜSSEL FALSCH`, false);
  else hud.setAuth(`${p === "gemini" ? "GEMINI" : "CLAUDE"}: BEREIT`, true);
  hud.setTelemetry({ core: coreLabel(), mic: micLabel(safe(() => ears.engine(), "keyboard")),
    wake: wakeLabel(safe(() => ears.wakeState(), "off")) });
  safe(() => sheets.refresh(), null);
}

function errorKey(e, prov = provider()) {
  const code = String(e?.code || "other");
  if (prov === "gemini") {
    if (code === "auth") return "err.gemini.auth";
    if (code === "rate" || code === "credit") return "err.gemini.rate";
    // erst wenn alle Gemini-Modelle überlastet / nicht erreichbar waren (api-3)
    if (code === "server" || code === "network" || code === "timeout") return `err.gemini.${code}`;
    return "err.other";
  }
  return intents.LINES[`err.${code}`] ? `err.${code}` : "err.other";
}

function errorText(e, prov = provider()) {
  if (typeof e?.say === "string" && e.say.trim()) return e.say.trim();
  return L(errorKey(e, prov));
}

// Kleine Probe-Anfrage für „Testen“ im Einstellungsblatt (falls brain.js keine eigene anbietet)
async function fetchTimeout(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw Object.assign(new Error(String(e?.message || e)), { code: ctl.signal.aborted ? "timeout" : "network" });
  } finally {
    clearTimeout(timer);
  }
}

function httpError(status, body) {
  const b = String(body || "");
  const code = status === 401 || status === 403 ? "auth"
    : status === 429 ? "rate"
      : status === 400 && /credit|balance|billing/i.test(b) ? "credit"
        : status === 400 && /api.?key|key not valid|invalid.*key/i.test(b) ? "auth"
          : status >= 500 ? "server" : "other";
  return Object.assign(new Error(`HTTP ${status}`), { code, status });
}

async function pingClaude(key) {
  const res = await fetchTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: brain.TIERS?.einfach?.model || "claude-haiku-5-5", max_tokens: 8,
      messages: [{ role: "user", content: "Sag nur: ok" }] }),
  });
  if (res.ok) return;
  throw httpError(res.status, await res.text().catch(() => ""));
}

async function pingGemini(key) {
  let last = null;
  for (const model of GEMINI_MODELS) {
    const res = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Sag nur: ok" }] }],
        generationConfig: { maxOutputTokens: 16 } }),
    });
    if (res.ok) return;
    const body = await res.text().catch(() => "");
    last = httpError(res.status, body);
    if (res.status === 404 || (res.status === 400 && /model/i.test(body) && !/api.?key/i.test(body))) continue;
    throw last;
  }
  throw last || Object.assign(new Error("Gemini"), { code: "other" });
}

async function brainTest(draft = {}) {
  const s = S();
  const d = {
    brainProvider: draft.brainProvider ?? s.brainProvider ?? "auto",
    anthropicKey: String(draft.anthropicKey ?? s.anthropicKey ?? "").trim(),
    geminiKey: String(draft.geminiKey ?? s.geminiKey ?? "").trim(),
  };
  const prov = providerFor(d);
  if (typeof brain.test === "function") {
    try {
      const r = await brain.test(d);
      if (r && typeof r === "object") return { ok: !!r.ok, text: String(r.text || (r.ok ? L("brainOk") : L("err.other"))) };
      return { ok: !!r, text: r ? L("brainOk") : L("err.other") };
    } catch (e) {
      return { ok: false, text: errorText(e, prov) };
    }
  }
  if (prov === "none") return { ok: false, text: L("noBrain") };
  try {
    if (prov === "claude") await pingClaude(d.anthropicKey);
    else await pingGemini(d.geminiKey);
    authBad = false;
    updateStatus();
    return { ok: true, text: L("brainOk") };
  } catch (e) {
    return { ok: false, text: errorText(e, prov) };
  }
}

// ---------------------------------------------------------------- Beschriftungen
function micLabel(engine) {
  if (engine === "native") return isIOS() ? "IPHONE" : "BROWSER";
  if (engine === "azure") return "AZURE";
  return "TASTATUR";
}

function wakeLabel(ws) {
  return WAKE_LABEL[ws] || "AUS";
}

function veilHint() {
  const s = S();
  const ws = safe(() => ears.wakeState(), "off");
  if (!s.wakeWord || !WAKE_RUNNING.has(ws)) return L("veilNoMic", { T: TAP2 });
  if (mode === "stealth") return L("veilStealth", { T: TAP2 });
  return L(muted ? "veilMuted" : "veilHidden", { T: TAP2 });
}

// ---------------------------------------------------------------- Zustand setzen
function setState(next, detail, opts = {}) {
  state = next;
  if (next !== "idle") activity();
  hud.setState(next, detail, opts);
}

function activity() {
  lastActivity = Date.now();
  if (dimmed) {
    dimmed = false;
    hud.setDim(false);
  }
}

// Wach halten nur, solange das Weckwort wirklich lauschen kann (nicht in Firefox, nicht bei gesperrtem Mikrofon)
function keepAwakeWanted() {
  const s = S();
  return !!(s.keepAwake && s.wakeWord) && WAKE_RUNNING.has(safe(() => ears.wakeState(), "off"));
}

function applyKeepAwake() {
  return awake.keepAwake(keepAwakeWanted()).catch((e) => { report("awake", e); return "none"; });
}

function wakeAvailable() {
  return !!S().wakeWord && WAKE_RUNNING.has(safe(() => ears.wakeState(), "off"));
}

function timingsFrom(s) {
  const ms = (v, d) => (Number.isFinite(Number(v)) ? Number(v) * 1000 : d);
  return {
    silenceMs: ms(s.silenceSeconds, 2000), hesitationMs: ms(s.hesitationSeconds, 2800), maxMs: ms(s.maxRecordSeconds, 50000),
    noSpeechMs: ms(s.noSpeechSeconds, 6000), followUpMs: ms(s.followUpSeconds, 4000),
  };
}

// ---------------------------------------------------------------- Sprechen
/** Ganze Antwort sprechen (Mac Controller.say: nur die ersten Sätze, Abschlussfrage bleibt). */
async function speak(text, my) {
  safe(() => ears.pauseWake(), null);
  const t0 = String(text ?? "").trim();
  if (muted || !t0 || (my && my === mutedTurn)) return;
  const s = S();
  const t = intents.voiceText(t0, { maxSentences: s.speakMaxSentences, maxChars: s.speakMaxChars,
    closing: store.closingPhrase() });
  if (!t) return;
  expectSpeech = my;
  if (state !== "speaking") setState("thinking", "Formuliere …");
  voice.say(t);
  hook.spoken.push(t);
  await voice.done();
}

/** Ein Satz aus dem Gehirn-Stream (Feeder hat das Sprech-Budget schon angewendet). */
function speakChunk(text, my) {
  if (my !== turn || muted || my === mutedTurn) return;
  const t = String(text ?? "").trim();
  if (!t) return;
  expectSpeech = my;
  voice.say(t);
  hook.spoken.push(t);
}

function finishTurn(my, fu = false) {
  if (my !== turn) return;
  expectSpeech = 0;
  // im Hintergrund kein Nachhören: kein Mikrofon und kein Ton in einer Seite, die man nicht sieht (robustness-9)
  if (fu && !muted && my !== mutedTurn && document.visibilityState !== "hidden") {
    setTimeout(() => {
      if (my !== turn) return;
      if (document.visibilityState === "hidden") { setState("idle", "Bereit."); resumeIdle(); return; }
      listen({ followUp: true });
    }, FOLLOW_UP_DELAY_MS);
    return;
  }
  setState("idle", "Bereit.");
  resumeIdle();
}

async function speakLine(key, my, vars = {}) {
  const t = L(key, vars);
  log("jarvis", t);
  lastAnswer = t;
  await speak(t, my);
  finishTurn(my, false);
}

// ---------------------------------------------------------------- Unterbrechen / Leerlauf (§4.5)
function restorePrehide() {
  if (prehidden && mode === "shown") hud.setVisibility("shown");
  prehidden = false;
}

function interrupt(restore = true) {
  safe(() => brain.cancel(), null);
  voice.stop();
  safe(() => ears.cancel(), null);
  safe(() => ears.pauseWake(), null);
  turnAbort.abort();
  turnAbort = new AbortController();
  listening = null;
  expectSpeech = 0;
  hud.setLive(null);
  if (restore) restorePrehide();
  else prehidden = false;
}

function stopAll() {
  turn++;
  interrupt();
  setState("idle", "Bereit.");
  resumeIdle();
}

function resumeIdle() {
  if (S().wakeWord && state === "idle" && !sheets.isOpen() && !inputFocused && !safe(() => voice.isSpeaking(), false)) {
    safe(() => ears.resumeWake(), null);
  }
}

// ---------------------------------------------------------------- Modi (§4.8)
function enterHidden({ fast = false, muted: m = false } = {}) {
  mode = "hidden";
  if (m) {
    muted = true;
    voice.setMuted(true);
    voice.stop();
  }
  prehidden = false;
  hud.setVisibility("hidden", { fast, hint: veilHint() });
  hud.setPaused(true);
  hud.hideImage();
  hud.hideModel();
  applyKeepAwake();
  syncHistory();
}

function enterStealth({ silent = false } = {}) {
  interrupt(false);
  mode = "stealth";
  muted = true;
  voice.setMuted(true);
  hud.hideImage();
  hud.hideModel();
  hud.clearLinks();
  hud.setVisibility("stealth", { fast: true, hint: veilHint() });
  hud.setPaused(true);
  setState("idle", "Bereit.");
  if (!silent) log("system", L("stealthLog"));
  applyKeepAwake();
  resumeIdle();
  syncHistory();
}

function leaveHidden({ pop = true } = {}) {
  mode = "shown";
  muted = false;
  voice.setMuted(false);
  prehidden = false;
  hud.setPaused(false);
  hud.setVisibility("shown", { pop });
  activity();
  applyKeepAwake();
}

function hasStealth(actions) {
  return (actions || []).some((a) => a && a.type === "hide_jarvis");
}

// ---------------------------------------------------------------- Aktionsergebnisse
function ctx(fromClaude, said, webUsed = false, webSeen = false) {
  return { now: new Date(), signal: turnAbort.signal, anrede: A(), wohnort: String(S().wohnort || ""), said,
    webUsed, webSeen, fromClaude };
}

function applyResult(r) {
  if (!r || typeof r !== "object") return;
  if (r.log && r.log.text) log(r.log.kind || "tool", r.log.text);
  if (r.link) {
    hud.showLink(r.link);
    if (!linkToastShown) {
      linkToastShown = true;
      hud.toast(MOUSE ? "Zum Öffnen anklicken." : "Zum Öffnen antippen.");
    }
  }
  if (r.image) {
    if (mode !== "shown") leaveHidden({ pop: true });
    hud.showImage(r.image, S().imageSeconds);
  }
  if (r.timer) hud.renderTimers(store.timers());
  if ("model" in r) {
    if (r.model) {
      if (mode !== "shown") leaveHidden({ pop: true });
      hud.showModel(r.model);
    } else hud.hideModel();
  }
  if (r.modelOp) hud.adjustModel(r.modelOp);
  if (r.orb) {
    if (mode !== "shown") leaveHidden({ pop: true });
    if (r.orb.op === "reset") hud.orbReset();
    else hud.orbZoom(r.orb.op);
  }
  if (r.ui === "stealth") enterStealth();
  else if (r.ui === "hide") enterHidden({ muted: false });
  else if (r.ui === "show") leaveHidden({ pop: true });
  else if (r.ui === "hide_image") hud.hideImage();
  syncHistory();
}

async function run(action, c) {
  try {
    const r = await tools.runAction(action, c);
    return r && typeof r === "object" ? r : { type: action?.type, ok: false };
  } catch (e) {
    report("action", e);
    return { type: action?.type, ok: false, say: L("actionFailed") };
  }
}

// ---------------------------------------------------------------- Text verarbeiten (§4.6)
function submitText(text, { spoken = false } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return Promise.resolve();
  muted = false;
  voice.setMuted(false);
  activity();
  return handleText(t, { spoken }).catch((e) => report("handle", e));
}

async function handleText(text, { spoken = false, prehidden: ph = false } = {}) {
  const my = ++turn;
  interrupt(false);
  activity();
  // ?wake=1 mit gesperrtem Ton: es kam ein Befehl → nach dem Tippen nur seine Antwort, kein „Ja, Boss?“ (robustness-4)
  if (pendingAfterUnlock === "wake") pendingAfterUnlock = "answer";
  // gesprochen: Mikrofon ist zu, Jarvis versteht (Mac „Verstehe …“); Antippen der Kugel = Stopp (robustness-8)
  if (spoken && (state === "listening" || state === "idle")) setState("transcribing", "Verstehe …");
  heardAt = heardAt && Date.now() - heardAt < 5000 ? heardAt : Date.now();
  hook.heard.push(text);
  log("user", text);
  const s = S();
  const ready = brainReady();
  let q = null;
  try {
    q = intents.quickIntent(text, {
      lastAnswer, findShortcut: (t) => store.findShortcut(t), anrede: A(), wohnort: String(s.wohnort || ""),
      imageOpen: hud.isImageOpen(), modelOpen: hud.isModelOpen(), timers: store.timers(), now: new Date(),
      brain: ready, facts: () => store.facts(),
    });
  } catch (e) {
    report("quickIntent", e);
    q = null;
  }
  if (q) {
    await quickPath(q, text, my, ph);
    return;
  }
  if (ph && mode === "shown") hud.setVisibility("shown");     // geht ans Gehirn: die Antwort soll man sehen
  if (!ready) {
    await noBrainTurn(my);
    return;
  }
  await brainTurn(text, my, spoken);
}

async function quickPath(q, text, my, ph) {
  const anrede = A();
  if (q.special === "stop") {
    if (ph && mode === "shown") hud.setVisibility("shown");
    stopAll();
    return;
  }
  if (q.special === "reset") {
    safe(() => brain.reset(), null);
    log("system", "Neues Gespräch gestartet.");
  }
  if (q.ui === "hide_fast" || q.ui === "hide") enterHidden({ fast: q.ui === "hide_fast", muted: false });
  if (q.special === "show") leaveHidden({ pop: true });
  const actions = Array.isArray(q.actions) ? q.actions : [];
  let answer = q.special === "repeat" ? (lastAnswer || L("repeatNothing")) : String(q.say || "");
  if (actions.length && !answer.trimEnd().endsWith("?")) answer = intents.confirmText(actions, answer, anrede);
  const results = [];
  if (actions.length) setState("thinking", "Einen Moment …");   // Wetter/Bild holen: nicht „BEREIT“, kein Timer dazwischen
  for (const a of actions) {
    const r = await run(a, ctx(false, text));
    if (my !== turn) return;
    results.push(r);
    applyResult(r);
    if (r.say) answer = r.say;                                // Mac: das Problem/Ergebnis ersetzt die Bestätigung
  }
  if (my !== turn) return;
  const hid = !!q.ui || results.some((r) => r.ui === "stealth" || r.ui === "hide");
  if (ph && !hid && mode === "shown") hud.setVisibility("shown");   // live ausgeblendet, war aber kein Schließen
  if (!hasStealth(actions)) answer = intents.withClosing(intents.bossOkay(answer, anrede), actions, store.closingPhrase());
  if (answer) {
    log("jarvis", answer);
    lastAnswer = answer;
    await speak(answer, my);
    finishTurn(my, !!q.followUp);
  } else {
    setState("idle", actions.length ? "Erledigt." : "Bereit.");
    resumeIdle();
  }
}

async function noBrainTurn(my) {
  const t = L("noBrain");
  log("jarvis", t);
  lastAnswer = t;
  hud.showLink({ url: SETUP_HREF, label: "Einstellungen", icon: "⚙" });
  await speak(t, my);
  finishTurn(my, false);
}

async function brainTurn(text, my, spoken) {
  const anrede = A();
  const prov = provider();
  setState("thinking", "Denke nach …");
  let res;
  try {
    res = await brain.ask(text, {
      spoken,
      signal: turnAbort.signal,
      onTier: (t) => { if (my === turn) hud.setTelemetry({ core: tierLabel(t) }); },
      onTool: (t) => {
        if (my !== turn) return;
        log("tool", `Websuche · ${String(t?.detail || "…")}`);
        if (state === "thinking") hud.setDetail("Suche im Web …");
      },
      onFirstText: () => { if (my === turn && state === "thinking") hud.setDetail("Formuliere …"); },
      onProgress: (note) => {                                 // Zwischenstand während der Websuche (api-4)
        if (my !== turn || state !== "thinking" || !note) return;
        hud.setDetail(note.length > 90 ? `${note.slice(0, 89)}…` : note);
      },
      onChunk: (c) => speakChunk(c, my),
      onLog: (kind, t) => log(kind || "system", t),
    });
  } catch (e) {
    if (my !== turn || e?.code === "aborted") return;
    if (e?.code === "nokey") {
      await noBrainTurn(my);
      return;
    }
    await errorTurn(e, my, prov);
    return;
  }
  if (my !== turn || !res) return;
  if (authBad) {
    authBad = false;
    updateStatus();
  }
  safe(() => store.addUsage(res.usage || {}), null);
  safe(() => hud.setDiagnostics({ ...store.usageToday(), latencyMs: lastLatency }), null);
  if (res.refusal) {
    voice.stop();
    await speakLine("refusal", my);
    return;
  }
  const raws = Array.isArray(res.actions) ? res.actions : [];
  if (res.empty && !raws.length) {                            // Mac: nicht an Jarvis gerichtet
    setState("idle", "Bereit.");
    resumeIdle();
    return;
  }
  const full = String(res.fullText || "").trim();
  if (full) log("jarvis", full);
  if (res.spokenText) lastAnswer = res.spokenText;
  // ---- Aktionen (Mac _think)
  const done = [], says = [];
  let problems = [];
  let blocked = false, timerS = 0;
  for (const raw of raws) {
    const a = safe(() => tools.normalizeAction(raw), null);
    if (!a) continue;
    if (res.webUsed && !tools.SAFE_AFTER_WEB.has(a.type)) { blocked = true; continue; }          // D15
    if (tools.LEARN_ACTIONS.has(a.type) && (res.webSeen || !intents.LEARN_SIGNAL.test(text.toLowerCase()))) {
      problems.push(L("learnOnlyOwn"));                                                             // D18
      continue;
    }
    const r = await run(a, ctx(true, text, !!res.webUsed, !!res.webSeen));
    if (my !== turn) return;
    applyResult(r);
    done.push(a);
    if (r.say) (SAY_TYPES.has(r.type || a.type) ? says : problems).push(r.say);
    if (a.type === "timer" && r.ok && r.timer) timerS = Number(r.timer.seconds) || 0;
  }
  if (my !== turn) return;
  let extra = "";
  if (res.spokenText) problems = problems.filter((p) => !String(p).startsWith("Okay"));
  else if (done.length && !problems.length && !says.length) extra = intents.confirmText(done, "", anrede);
  if (!res.spokenText && !extra && timerS) {
    const end = new Date(Date.now() + timerS * 1000);
    extra = timerS > 3600 ? L("alarmSet", { h: end.getHours(), mm: pad2(end.getMinutes()) })
      : L("timerSet", { dauer: intents.sayDuration(timerS) });
  }
  if (blocked) problems.push(L("blockedAfterWeb"));
  extra = [extra, ...says, ...problems].filter(Boolean).join(" ");
  let tail = extra ? intents.bossOkay(extra, anrede) : "";
  const closing = done.length && !hasStealth(done) ? store.closingPhrase() : "";
  const all = `${String(res.spokenText || "")} ${tail}`.trim();
  if (closing && all && !all.endsWith("?") && !all.includes(closing)
    && !done.some((a) => intents.CLOSING_EXCLUDED.has(a.type))) tail = `${tail} ${closing}`.trim();
  if (tail) {
    log("jarvis", tail);
    if (!res.spokenText) lastAnswer = tail;
    if (!muted && my !== mutedTurn) {
      const s = S();
      const t = intents.voiceText(tail, { maxSentences: s.speakMaxSentences, maxChars: s.speakMaxChars, closing });
      expectSpeech = my;
      voice.say(t);
      hook.spoken.push(t);
    }
  }
  if (hasStealth(done)) return;                               // enterStealth hat schon alles beendet
  if (!res.spokenText && !tail) {
    setState("idle", done.length ? "Erledigt." : "Bereit.");
    resumeIdle();
    return;
  }
  await voice.done();
  finishTurn(my, false);                                      // follow_up_after_answer = false (Mac config)
}

async function errorTurn(e, my, prov) {
  setState("error", "Fehler");
  voice.chime("error");
  const t = errorText(e, prov);
  log("error", `${t} (${String(e?.message || e?.code || "Fehler")})`);
  lastAnswer = t;
  if (e?.code === "auth") {
    authBad = true;
    updateStatus();
  }
  await speak(t, my);
  if (my !== turn) return;
  if (e?.code === "auth") sheets.open("setup", { section: "brain" });
  finishTurn(my, false);
}

// ---------------------------------------------------------------- Zuhören (§4.4, §4.5)
function listen({ followUp: fu = false, fromTap = false } = {}) {
  interrupt();
  const my = ++turn;
  muted = false;
  voice.setMuted(false);
  activity();
  if (mode !== "shown") leaveHidden({ pop: true });
  if (safe(() => ears.engine(), "keyboard") === "keyboard") {
    // Mikrofon gesperrt, aber dieses Tippen versucht es gerade neu (Erlaubnis inzwischen erteilt?): abwarten und dann
    // zuhören statt sofort die Tastatur – sonst bleibt das Weckwort für immer GESPERRT (robustness-1)
    const p = micUnlock;
    if (p && safe(() => ears.blockReason(), null)) {
      setState("idle", "Mikrofon …");
      p.then((ok) => {
        if (my !== turn) return;
        if (ok && safe(() => ears.engine(), "keyboard") !== "keyboard") listen({ followUp: fu });
        else keyboardFallback(false);
      }, () => { if (my === turn) keyboardFallback(false); });
      return;
    }
    keyboardFallback(fromTap);
    return;
  }
  if (!fu) voice.chime("wake");
  let l;
  try {
    l = ears.listen({ followUp: fu });
  } catch (e) {
    report("listen", e);
    keyboardFallback(fromTap);
    return;
  }
  runListening(l, { followUp: fu }, my).catch((e) => report("listening", e));
}

async function runListening(l, { followUp: fu = false } = {}, my = turn) {
  listening = l;
  prehidden = false;
  heardPartial = false;
  setState("listening", fu ? L("followUpDetail") : "Ich höre zu …", { soft: fu });
  hud.pauseImage(true);
  imagePausedBy = l;
  let res;
  try {
    res = await l.promise;
  } catch (e) {
    res = { text: "", reason: "error", prehidden: false, error: { code: "unavailable", message: String(e?.message || e) } };
  }
  // die Bild-Zeit läuft weiter, auch wenn diese Runde überholt wurde (getippter Befehl, Stopp) – sonst bleibt das
  // Bild für immer stehen und verdeckt die Kugel (robustness-3)
  if (imagePausedBy === l) {
    imagePausedBy = null;
    hud.pauseImage(false);
  }
  if (my !== turn) return;
  if (listening === l) listening = null;
  hud.setLive(null);
  res = res || { text: "", reason: "cancelled" };
  const ph = !!(res.prehidden || prehidden);
  prehidden = false;
  const reason = res.reason;
  if (reason === "bare") {
    sayPresence({ followUp: true });
    return;
  }
  if (reason === "error") {
    if (ph && mode === "shown") hud.setVisibility("shown");
    earError(res.error);
    return;
  }
  const raw = String(res.text || "");
  if (reason === "cancelled" || !raw.trim()) {
    if (ph && mode === "shown") hud.setVisibility("shown");   // Mac: live ausgeblendet, dann kam nichts
    setState("idle", reason === "cancelled" || fu ? "Bereit." : "Nichts gehört.");
    resumeIdle();
    return;
  }
  const text = intents.cleanTranscript(intents.stripWakePrefix(raw));
  if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 2) {
    if (ph && mode === "shown") hud.setVisibility("shown");
    setState("idle", "Nicht verstanden.");
    resumeIdle();
    return;
  }
  voice.chime("done");
  heardAt = Date.now();
  await handleText(text, { spoken: true, prehidden: ph });
}

async function sayPresence({ followUp: fu = false } = {}) {
  const my = ++turn;
  const t = L("presence");
  log("jarvis", t);
  lastAnswer = t;
  await speak(t, my);
  if (my !== turn) return;
  finishTurn(my, fu);
}

function orbTap() {
  activity();
  if (!booted) return;
  if (state === "transcribing" || state === "thinking" || state === "speaking") {
    stopAll();                                                // auch während VERSTEHE (Azure lädt hoch, robustness-11)
    return;
  }
  if (listening) {
    listening.finish();                                       // D6: Antippen = „fertig“
    return;
  }
  listen({ fromTap: true });
}

function keyboardFallback(fromTap) {
  setState("idle", TYPE_DETAIL);
  if (fromTap) {
    hud.focusInput();                                         // synchron im Tippen (bug 3)
  } else {
    hud.toast(MOUSE ? "Tipp deine Frage unten ins Feld." : "Tipp unten ins Feld und nutze das Mikrofon der Tastatur zum Diktieren.", 4000);
    hud.setLive(TYPE_DETAIL);
  }
  showNoListenHint();
}

function showNoListenHint() {
  if (noListenShown) return;
  const caps = safe(() => ears.capabilities(), { native: false, azure: false });
  if (caps.native || caps.azure) return;
  noListenShown = true;
  log("system", L("noListen"));
  hud.toast(L("noListen"), 5000);
}

// Siri/Diktierfunktion aus oder Sprachdienst gerade weg (service-not-allowed) – nicht das Mikrofon (WebKit trennt das)
function logServiceOff() {
  if (serviceLogged) return;
  serviceLogged = true;
  log("system", L(isIOS() ? "speechOff" : "speechOffWeb"));
}

function logMicDenied() {
  if (safe(() => ears.blockReason(), null) === "service") { logServiceOff(); return; }
  if (micDeniedLogged) return;
  micDeniedLogged = true;
  log("system", L(isStandalone() && isIOS() ? "micDenied" : "micDeniedWeb"));
}

function earError(err) {
  const code = err?.code;
  if (code === "denied") {
    logMicDenied();
    hud.setTelemetry({ wake: "GESPERRT" });
  } else if (code === "service") {
    logServiceOff();
    hud.setTelemetry({ wake: "GESPERRT" });
  } else if (code === "network") {
    log("system", "Die Spracherkennung braucht Internet.");
    hud.toast("Die Spracherkennung braucht Internet.");
  } else if (code === "nomic") {
    log("system", "Ich finde kein Mikrofon.");
  } else if (code === "azure") {
    log("system", "Die Azure-Spracherkennung antwortet nicht.");
  }
  if (safe(() => ears.engine(), "keyboard") === "keyboard") keyboardFallback(false);
  else {
    setState("idle", "Bereit.");
    resumeIdle();
  }
}

// ---------------------------------------------------------------- Weckwort-Ereignisse (ears)
const earHandlers = {
  onWake(hit, l) {
    if (state !== "idle" && state !== "error") {              // D5 (ears liefert dann eigentlich nicht)
      safe(() => l.cancel(), null);
      return;
    }
    turn++;
    muted = false;
    voice.setMuted(false);
    activity();
    if (mode !== "shown") leaveHidden({ pop: true });          // Overlay springt auf (Mac main.js)
    else hud.setVisibility("shown", { pop: true });
    voice.chime("wake");
    runListening(l, { followUp: false }, turn).catch((e) => report("wake", e));
  },
  onPartial(text) {
    if (!listening) return;
    const t = String(text ?? "").trim();
    if (t) heardPartial = true;
    hud.setLive(t ? `„${t}“` : null);
    activity();
  },
  onLevel(level) {
    hud.setLevel(level);
  },
  onPrehide() {
    if (!listening || mode !== "shown") return;
    prehidden = true;                                         // Mac prehide: sofort weg, Satz läuft weiter
    hud.setVisibility("hidden", { fast: true, hint: L("veilHidden", { T: TAP2 }) });
  },
  onPhase(phase) {
    if (phase === "transcribing" && listening) setState("transcribing", "Verstehe …");
  },
  onWakeState(ws) {
    hud.setTelemetry({ wake: wakeLabel(ws) });
    if (ws === "blocked") {
      if (safe(() => ears.blockReason(), null) === "service") logServiceOff();
      markMicBlocked();
    }
    if (ws === "unsupported" && booted) showNoListenHint();
    hud.setWakeHint(wakeAvailable());
    if (mode !== "shown" && state === "idle") hud.setVisibility(mode, { fast: true, hint: veilHint() });
    safe(() => sheets.refresh(), null);
    if (booted) applyKeepAwake();                             // nur wach halten, solange wirklich gelauscht wird
  },
  onEngine(name) {
    hud.setTelemetry({ mic: micLabel(name) });
    safe(() => sheets.refresh(), null);
  },
  onLog(kind, text) {
    log(kind || "system", text);
  },
};

function markMicBlocked() {
  if (!S().wakeWord) return;
  locked.mic = true;
  installUnlockListeners();
}

function startWake(gesture) {
  const gen = ++wakeGen;
  // inzwischen wieder ausgeschaltet (zweimal schnell getippt): nichts mehr starten – der Knopf sagt „aus“ (robustness-2)
  const stale = () => gen !== wakeGen || !S().wakeWord;
  const after = (ws) => {
    if (stale()) return;
    if (ws === "blocked") markMicBlocked();
    if (state !== "idle" || sheets.isOpen() || inputFocused || safe(() => voice.isSpeaking(), false)) safe(() => ears.pauseWake(), null);
    if (mode !== "shown" && state === "idle") hud.setVisibility(mode, { fast: true, hint: veilHint() });
  };
  if (gesture && safe(() => ears.capabilities().native, false)) {
    ears.unlockInGesture()
      .then((ok) => {
        if (ok) locked.mic = false;
        if (stale()) return safe(() => ears.wakeState(), "off");
        return ears.startWake();
      })
      .then(after, (e) => report("wake", e));
    return;
  }
  ears.startWake().then(after, (e) => report("wake", e));
}

// ---------------------------------------------------------------- Freischalten (§4.3)
// Jede echte Berührung (Tippen, Klick, Taste) schaltet frei; Tasten zählen auch (Rechner, CR3).
function onUnlockKey(e) {
  if (!e.isTrusted || UNLOCK_KEYS_IGNORED.has(e.key) || e.ctrlKey || e.metaKey) return;
  onUnlockGesture(e);
}

function installUnlockListeners() {
  if (unlockInstalled) return;
  unlockInstalled = true;
  document.addEventListener("touchend", onUnlockGesture, true);
  document.addEventListener("click", onUnlockGesture, true);
  document.addEventListener("keydown", onUnlockKey, true);
}

function removeUnlockListeners() {
  if (!unlockInstalled) return;
  unlockInstalled = false;
  document.removeEventListener("touchend", onUnlockGesture, true);
  document.removeEventListener("click", onUnlockGesture, true);
  document.removeEventListener("keydown", onUnlockKey, true);
}

function showUnlockCatcher(answer = false) {
  awakeCatcher = false;
  hud.showUnlock(LM(answer ? "unlockAnswer" : "unlockStart"));
  installUnlockListeners();
}

// Hintergrund-Start und ?wake=1 ohne Wake Lock: Safari erteilt die Sperre nur in einer Berührung – einmal fragen,
// sonst sperrt sich das iPhone nach der Auto-Sperre und Jarvis hört nichts mehr (§4.3, ios-1).
function maybeAwakeCatcher() {
  if (awakeCatcherShown || !booted || !safe(() => awake.needsGesture(), false)) return;
  if (safe(() => hud.isUnlockShown(), false)) return;          // der normale Fänger tut es mit
  awakeCatcherShown = true;
  awakeCatcher = true;
  hud.showUnlock(LM("unlockAwake"));
  installUnlockListeners();
}

// Erste Berührung jedes Seitenaufrufs (alle Wege): Wake Lock mit Nutzeraktivierung (iOS), Gerätestimme freischalten.
// Die Sperre wird auch geholt, wenn das Weckwort erst durch dieses Tippen anläuft (Mikrofon-Freigabe); ob sie bleibt,
// entscheidet danach applyKeepAwake().
function gestureBasics() {
  const s = S();
  const intent = keepAwakeWanted() || (!!(s.keepAwake && s.wakeWord) && locked.mic);
  safe(() => awake.inGesture(intent), null);
  safe(() => voice.primeInGesture(), null);
}

function onUnlockGesture() {
  gestureBasics();                                            // synchron in der Berührung
  if (!locked.audio && !locked.mic) {
    if (awakeCatcher) {
      awakeCatcher = false;
      hud.showUnlock(null);
    }
    removeUnlockListeners();
    if (booted) applyKeepAwake();
    return;
  }
  if (unlocking) return;
  unlocking = true;
  // synchroner Teil im Tippen: Ton und Spracherkennung freischalten
  const a = locked.audio || !voice.isUnlocked() ? voice.unlockInGesture() : Promise.resolve(true);
  const native = safe(() => ears.capabilities().native, false);
  // dauerhaft verweigert (Berechtigung „denied“) oder in diesem Seitenbesuch schon im Tippen erneut abgelehnt: nicht bei
  // jedem Tippen neu fragen – sonst öffnet das Antippen der Kugel nie mehr die Tastatur (robustness-1)
  const tryMic = native && (locked.mic || S().wakeWord) && safe(() => ears.micPermission(), null) !== "denied"
    && !(micRetryFailed && safe(() => ears.blockReason(), null));
  const m = (tryMic ? ears.unlockInGesture() : Promise.resolve(!locked.mic)).catch(() => false);
  micUnlock = tryMic ? m : null;
  Promise.all([a.catch(() => false), m]).then(async ([audioOk, micOk]) => {
    // Mikrofon weiter gesperrt: die Listener bleiben; nach der Rückkehr auf die Seite (Erlaubnis inzwischen in den
    // Einstellungen erteilt?) versucht das nächste Tippen es wieder (robustness-1)
    const stillBlocked = !micOk && !!safe(() => ears.blockReason(), null);
    if (tryMic) micRetryFailed = stillBlocked;
    locked = { audio: !audioOk, mic: stillBlocked };
    if (!micOk && (stillBlocked || tryMic)) {                 // Mikrofon verweigert: Jarvis bleibt per Tippen nutzbar
      logMicDenied();
      hud.setTelemetry({ wake: "GESPERRT" });
    }
    if (!locked.audio) {
      awakeCatcher = false;
      hud.showUnlock(null);
      if (!locked.mic) removeUnlockListeners();
    }
    // Ton war gesperrt und voice spielt jetzt die wartende Antwort ab: das ist „SPRICHT“, kein offenes Mikrofon (D5,
    // robustness-5); danach zurück in BEREIT mit Weckwort
    const replaying = !locked.audio && !expectSpeech && state !== "speaking" && safe(() => voice.isSpeaking(), false);
    if (replaying) {
      const my = turn;
      safe(() => ears.pauseWake(), null);
      setState("speaking", "Spreche …");
      voice.done().then(() => {
        if (my !== turn || state !== "speaking") return;
        setState("idle", "Bereit.");
        resumeIdle();
      });
    }
    if (micOk && S().wakeWord && !replaying) {
      try { await ears.startWake(); } catch (e) { report("wake", e); }
      if (state !== "idle" || sheets.isOpen() || inputFocused || safe(() => voice.isSpeaking(), false)) safe(() => ears.pauseWake(), null);
    }
    const pending = pendingAfterUnlock;
    if (locked.audio) return;
    pendingAfterUnlock = null;
    if (pending === "greeting") continueBoot("normal");
    else if (pending === "background") continueBoot("background");
    else if (pending === "wake") {
      if (!booted) continueBoot("wake");
      else if (listening && !heardPartial) {
        // ?wake=1: das stille Zuhören vor dem Tippen hat nichts gehört → jetzt hörbar: Ton, „Ja, Boss?“, nachhören
        const l = listening;
        listening = null;
        safe(() => l.cancel(), null);
        hud.setLive(null);
        wakeFromOutside({ force: true });
      } else if (!listening && (state === "idle" || state === "error" || state === "loading")) wakeFromOutside({ force: true });
      // sonst läuft schon ein Befehl: seine Antwort spielt voice nach dem Freischalten selbst ab
    }
    // "answer": voice spielt die wartenden Sätze nach dem Freischalten selbst ab
  }).catch((e) => report("unlock", e)).finally(() => {
    unlocking = false;
    if (micUnlock === m) micUnlock = null;
    if (booted) applyKeepAwake();                             // Sperre aus dem Tippen nur behalten, wenn gelauscht wird
  });
}

// ---------------------------------------------------------------- Wecken von außen (§4.4.3)
function wakeFromOutside({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastOutsideWake < OUTSIDE_WAKE_DEDUPE_MS) return;   // visibilitychange + pageshow: einmal
  lastOutsideWake = now;
  interrupt();                                                // kein zweites „Ja, Boss?“ hinter dem ersten
  turn++;
  muted = false;
  voice.setMuted(false);
  if (mode !== "shown") leaveHidden({ pop: true });
  else hud.setVisibility("shown", { pop: true });
  if (locked.audio || locked.mic) {
    showUnlockCatcher(false);
    pendingAfterUnlock = "wake";                              // §4.4.3: nach dem Tippen „Ja, Boss?“ (oder die Antwort)
    if (!locked.mic) listen();                                // schon zuhören: wer gleich spricht, bekommt die Antwort
    return;
  }
  voice.chime("wake");
  sayPresence({ followUp: true }).catch((e) => report("presence", e));
}

// ---------------------------------------------------------------- Timer (§4.9)
// „während ich geschlossen war“ nur, wenn die Seite wirklich zu oder eingefroren war: lief sie (auch als gedrosselter
// Hintergrund-Tab mit einem Weckruf pro Minute), ist der Timer einfach abgelaufen.
function handleDue(due, now, alive = false) {
  const missed = [];
  for (const t of due) {
    const late = now - Number(t.ends);
    const ranOut = alive && Number(t.ends) >= PAGE_START;     // abgelaufen, während diese Seite schon lief
    if (late <= TIMER_LATE_MS || (ranOut && late <= TIMER_ALIVE_GAP_MS)) announce(L("timerDone", { label: t.label }));
    else if (late <= TIMER_MISSED_MS) missed.push(t);
    // länger her: still verwerfen (live Mac Timers.restore)
  }
  if (missed.length) announce(L("timerMissed", { label: missed[0].label }));
}

// Eigener Weckruf genau zum Ablauf des nächsten Timers: ein frischer setTimeout wird im Hintergrund-Tab nicht wie
// der Sekundentakt auf eine Minute gedrosselt (Chrome „intensive throttling“).
function scheduleTimerWake() {
  clearTimeout(timerWake);
  timerWake = 0;
  let list = [];
  try { list = store.timers(); } catch { list = []; }
  const next = list.reduce((m, t) => Math.min(m, Number(t.ends) || Infinity), Infinity);
  if (!Number.isFinite(next)) return;
  const ms = Math.max(0, Math.min(next - Date.now() + 30, 2 ** 31 - 1));
  timerWake = setTimeout(() => { timerWake = 0; tick(); scheduleTimerWake(); }, ms);
}

function announce(text) {
  announceChain = announceChain.then(() => doAnnounce(text)).catch((e) => report("announce", e));
}

async function doAnnounce(text) {
  const start = Date.now();
  while (Date.now() - start < ANNOUNCE_MAX_MS
    && !((state === "idle" || state === "error") && !listening && booted)) {
    await sleep(ANNOUNCE_POLL_MS);                            // bug 6: nicht ins offene Mikrofon sprechen
  }
  interrupt();
  const my = ++turn;
  if (mode !== "shown") leaveHidden({ pop: true });
  muted = false;
  voice.setMuted(false);
  voice.chime("timer");
  log("jarvis", text);
  lastAnswer = text;
  await speak(text, my);
  finishTurn(my, false);
}

function tick() {
  const now = Date.now();
  // lief die Seite seit dem letzten Takt durch (höchstens gedrosselt)? Vor dem ersten Takt zählt der Seitenstart.
  const alive = now - (lastTickAt || PAGE_START) <= TIMER_ALIVE_GAP_MS;
  lastTickAt = now;
  let due = [];
  try { due = store.takeDue(now); } catch (e) { report("timers", e); }
  safe(() => hud.renderTimers(store.timers(), now), null);
  if (due.length) handleDue(due, now, alive);
  syncHistory();
  const s = S();
  if (state === "idle" && !voice.isSpeaking() && !listening) {
    const quiet = now - lastActivity;
    if (!dimmed && quiet > (Number(s.idleFadeSeconds) || 45) * 1000) {
      dimmed = true;
      hud.setDim(true);
    }
    const minutes = Number(s.autoHideMinutes) || 0;
    if (mode === "shown" && booted && minutes > 0 && quiet > minutes * 60000 && !sheets.isOpen() && !inputFocused) {
      enterHidden({ fast: false, muted: false });             // D13: nach 10 min Ruhe schwarz, lauscht weiter
      resumeIdle();
    }
  }
}

// ---------------------------------------------------------------- Einstellungen
function applySettings(next) {
  const prev = lastSettings || {};
  lastSettings = next;
  const ch = (k) => prev[k] !== next[k];
  if (ch("theme")) hud.setTheme(next.theme);
  if (ch("firma") || ch("wohnort") || ch("galaxyBrightness") || ch("vorname")) {
    hud.setBrand({ firma: next.firma, wohnort: next.wohnort, galaxyBrightness: next.galaxyBrightness, vorname: next.vorname });
  }
  if (ch("anrede")) intents.setAnrede(store.anrede());
  if (TIMING_KEYS.some(ch)) ears.setTimings(timingsFrom(next));
  if (ch("azureKey") || ch("azureRegion") || ch("voicePreset") || ch("voiceSpeed")) safe(() => voice.resetAzure(), null);
  if (ch("focus")) hud.setFocus(!!next.focus);
  if (ch("wakeWord")) {
    hud.setWakeButton(!!next.wakeWord);
    if (booted) {
      if (next.wakeWord) startWake(gestureNow);
      else {
        wakeGen++;                                            // ein noch laufender Start (Freischalten) startet nichts mehr
        safe(() => ears.stopWake(), null);
      }
    }
  }
  if (ch("wakeWord") || ch("keepAwake")) applyKeepAwake();
  if (["anthropicKey", "geminiKey", "brainProvider", "azureKey", "wakeWord"].some(ch)) {
    if (ch("anthropicKey") || ch("geminiKey") || ch("brainProvider")) authBad = false;
    updateStatus();
  }
}

async function onSave(patch) {
  const hadBrain = brainReady();
  gestureNow = true;                                          // synchron im Speichern-Tippen
  try {
    store.setSettings(patch || {});
    applySettings(S());
  } finally {
    gestureNow = false;
  }
  if (!hadBrain && brainReady() && booted) {                  // erster gültiger Schlüssel: kurz bestätigen
    const my = ++turn;
    interrupt();
    muted = false;
    voice.setMuted(false);
    log("system", "Gehirn verbunden.");
    // nicht abwarten: das Blatt schließt sofort, Jarvis spricht danach (sonst bleibt „Speichern“ hängen)
    speakLine("connected", my).catch((e) => report("connected", e));
  }
}

function toggleWake() {
  const on = !S().wakeWord;
  gestureNow = true;
  try {
    store.setSettings({ wakeWord: on });
    applySettings(S());
  } finally {
    gestureNow = false;
  }
}

// ---------------------------------------------------------------- Befehle (§4.10)
function onCommand(cmd) {
  activity();
  switch (cmd) {
    case "listen":
      listen({ fromTap: true });
      break;
    case "mic":
      orbTap();
      break;
    case "stop":
      stopAll();
      break;
    case "new_session":
      safe(() => brain.reset(), null);
      log("system", "Neues Gespräch gestartet.");
      break;
    case "wake":
      toggleWake();
      break;
    case "voice":
      sheets.open("setup", { section: "voice" });
      break;
    case "focus": {
      const on = !S().focus;
      store.setSettings({ focus: on });
      hud.setFocus(on);
      break;
    }
    case "hide":
      stopAll();
      enterHidden({ muted: false });
      resumeIdle();
      break;
    case "stealth":
      enterStealth();
      break;
    case "setup":
    case "open_setup":
      sheets.open("setup");
      break;
    case "open_help":
      sheets.open("help");
      break;
    case "open_data":
      sheets.open("data");
      break;
    case "close":
      stopAll();
      enterHidden({ muted: true });                           // Mac ✕: stumm und weg, lauscht weiter
      resumeIdle();
      break;
    default:
      break;
  }
}

function greetingWord(d = new Date()) {
  const h = d.getHours();
  return h < 11 ? "Guten Morgen" : h < 18 ? "Guten Tag" : "Guten Abend";
}

function onSheetCommand(cmd, detail = {}) {
  switch (cmd) {
    case "voice_test":
      return voice.test(L("voiceTest", { greeting: greetingWord() }), detail?.draft || {}).catch((e) => report("voice test", e));
    case "history_clear":
      safe(() => brain.reset(), null);
      log("system", "Neues Gespräch gestartet.");
      return undefined;
    case "log_clear":
      safe(() => hud.restoreLog([]), null);
      return undefined;
    case "brain_test":
      return brainTest(detail?.draft || {});
    case "import_done":
      importPending = null;
      if (detail?.accepted) {
        log("system", "Einstellungen übernommen.");
        updateStatus();
      }
      return undefined;
    case "wipe_done":
      return undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- hud-Rückrufe
const hudCallbacks = {
  onOrbTap: orbTap,
  onCommand,
  onTimerCancel(id) {
    safe(() => store.cancelTimers(id), null);
    hud.renderTimers(store.timers());
  },
  onVeilDoubleTap() {
    leaveHidden({ pop: true });
    resumeIdle();
  },
  onUnlockTap() {
    onUnlockGesture();
  },
  onSubmit(text) {
    submitText(text, { spoken: false });
  },
  onInputFocus(focused) {
    inputFocused = !!focused;
    activity();
    if (inputFocused) {
      safe(() => ears.pauseWake(), null);
      return;
    }
    // Absenden blendet die Eingabe aus und startet gleich danach eine Runde: dann kein Weckwort-Start dazwischen
    // (sonst startet und bricht die Erkennung bei jedem getippten Befehl ab – Android piept jedes Mal)
    const my = turn;
    setTimeout(() => { if (turn === my && !inputFocused) resumeIdle(); }, 0);
  },
  onLinkTap(link) {
    activity();
    if (link && link.url === SETUP_HREF) sheets.open("setup", { section: "brain" });
  },
  onDeckPage(index) {
    if (Number.isInteger(index)) safe(() => store.setSettings({ deckPage: index }), null);
  },
  onModelClosed() {
    activity();
    syncHistory();
  },
};

const sheetCallbacks = {
  onSave,
  onCommand: onSheetCommand,
  onOpenChange(name) {
    activity();
    if (name) {
      safe(() => ears.pauseWake(), null);
      safe(() => hud.hideToast(), null);                      // „Zum Öffnen antippen.“ gehört nicht über ein Blatt
    } else resumeIdle();
    syncHistory();
  },
  status() {
    const s = S();
    const claude = String(s.anthropicKey || "").trim();
    const gemini = String(s.geminiKey || "").trim();
    const bad = (claude && !CLAUDE_KEY_RX.test(claude)) || (gemini && !GEMINI_KEY_RX.test(gemini));
    return {
      keyState: bad ? "UNGÜLTIG" : brainReady() ? "GESPEICHERT" : "FEHLT",
      voiceState: safe(() => voice.engineLabel(), ""),
      micState: micLabel(safe(() => ears.engine(), "keyboard")),
      wakeState: wakeLabel(safe(() => ears.wakeState(), "off")),
      standalone: isStandalone(),
      provider: provider(),
    };
  },
  toast(text) {
    hud.toast(text);
  },
};

// ---------------------------------------------------------------- Zurück-Taste (Android, Browser-Zurück)
// Offenes Blatt oder 3D-Modell = ein eigener Verlaufseintrag: „Zurück“ schließt es, statt Jarvis zu verlassen.
function layerOpen() {
  return !!(safe(() => sheets.isOpen(), false) || safe(() => hud.isModelOpen(), false));
}

function syncHistory() {
  const open = layerOpen();
  if (open && !historyPushed) {
    try {
      history.pushState({ jarvisLayer: true }, "");
      historyPushed = true;
    } catch { /* ignore */ }
  } else if (!open && historyPushed) {
    historyPushed = false;
    if (history.state && history.state.jarvisLayer) {
      ignorePops++;
      try { history.back(); } catch { ignorePops--; }
    }
  }
}

function onPopState() {
  if (ignorePops > 0) {
    ignorePops--;
    return;
  }
  if (!historyPushed) return;
  historyPushed = false;
  activity();
  if (safe(() => sheets.isOpen(), false)) sheets.close();
  else if (safe(() => hud.isModelOpen(), false)) hud.hideModel();
  syncHistory();                                              // darunter noch etwas offen: neuer Eintrag
}

// ---------------------------------------------------------------- Dokument-Ereignisse
function onVisibility() {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    // die laufende Runde redet nicht im Hintergrund weiter (Text kommt ins Protokoll), robustness-9
    if (state === "thinking" || state === "speaking" || state === "transcribing") mutedTurn = turn;
    voice.stop();
    safe(() => ears.pauseWake(), null);
    hud.setPaused(true);
    return;
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  micRetryFailed = false;                                     // vielleicht in den Einstellungen erlaubt: wieder versuchen
  hud.setPaused(mode !== "shown");
  tick();
  applyKeepAwake();
  resumeIdle();
  if (booted && S().listenOnOpen && away >= LISTEN_ON_OPEN_MS) wakeFromOutside();
}

function onKeyDown(e) {
  activity();
  if (e.key === "Escape") {
    if (sheets.isOpen()) return;                              // Blätter schließt sheets.js
    if (hud.isModelOpen()) hud.hideModel();
    else if (hud.isImageOpen()) hud.hideImage();
    syncHistory();
    return;
  }
  if (!e.ctrlKey || !e.altKey || e.metaKey) return;          // Mac-Tastenkürzel (CR3)
  if (e.code === "Space") {
    e.preventDefault();
    listen({ fromTap: true });
  } else if (e.code === "KeyJ") {
    e.preventDefault();
    if (mode === "shown") {
      stopAll();
      enterHidden({ muted: false });
    } else leaveHidden({ pop: true });
    resumeIdle();
  } else if (e.code === "KeyK") {
    e.preventDefault();
    onCommand("focus");
  }
}

// ⚙-Knopf aus dem Gratis-Hinweis: kein Seitenwechsel, sondern das Einstellungsblatt
function onSetupLinkClick(e) {
  const a = e.target?.closest?.("#actionbar a");
  if (a && a.getAttribute("href") === SETUP_HREF) e.preventDefault();
}

function onStoreTopics() {
  store.on("settings", (s) => applySettings(s || S()));
  store.on("timers", (list) => {
    hud.renderTimers(Array.isArray(list) ? list : store.timers());
    scheduleTimerWake();
  });
  store.on("konto", (k) => {
    hud.renderKonto(k ?? store.konto());
    hud.renderTermine(k ?? store.konto());
    safe(() => sheets.refresh(), null);
  });
  store.on("usage", () => safe(() => hud.setDiagnostics({ ...store.usageToday(), latencyMs: lastLatency }), null));
  store.on("facts", () => safe(() => sheets.refresh(), null));
  store.on("shortcuts", () => safe(() => sheets.refresh(), null));
  store.on("history", () => safe(() => sheets.refresh(), null));
}

function wireVoice() {
  voice.on("start", () => {
    if (!expectSpeech || expectSpeech !== turn) return;
    if (state !== "speaking") setState("speaking", "Spreche …");
    if (heardAt) {
      lastLatency = Date.now() - heardAt;
      heardAt = 0;
      hud.setTelemetry({ latencyMs: lastLatency });
    }
  });
  voice.on("level", (level, bands) => hud.setLevel(level, bands));
  voice.on("warn", (text) => log("system", text));
  voice.on("blocked", () => {
    locked.audio = true;
    if (!pendingAfterUnlock) pendingAfterUnlock = "answer";
    showUnlockCatcher(true);
  });
  voice.on("engine", () => safe(() => sheets.refresh(), null));
}

// ---------------------------------------------------------------- Start (§4.2)
function continueBoot(reason) {
  booted = true;
  pendingAfterUnlock = null;
  if (reason === "wake") {
    setState("idle", "Bereit.");
    wakeFromOutside();
  } else if (reason === "background") {
    setState("idle", "Bereit.");
    enterStealth({ silent: true });
    log("system", "Hintergrund-Modus: lausche unsichtbar auf „Jarvis“.");
  } else {
    const wakeOk = wakeAvailable();                           // Firefox, Mikrofon gesperrt: kein „Sag Hey Jarvis“
    setState("idle", LM(wakeOk ? "idleBoot" : "idleBootNoWake"));
    log("system", L(wakeOk ? "readyLog" : "readyLogNoWake"));
    // D7; nicht, solange die Frage „Einstellungen übernehmen?“ offen ist
    if (S().greeting && !importPending) sayPresence({ followUp: true }).catch((e) => report("greeting", e));
    else resumeIdle();
  }
  hud.setWakeHint(wakeAvailable());
  showNoListenHint();
  if (safe(() => voice.usesAzure(), false)) {
    voice.prewarm(voice.warmPhrases(A(), store.closingPhrase())).catch(() => 0);
  }
  const p = applyKeepAwake();
  scheduleTimerWake();
  if (reason !== "normal") p.then(() => maybeAwakeCatcher());   // ios-1: Sperre gibt es auf dem iPhone nur per Tippen
}

async function init() {
  const imp = BOOT_IMPORT;
  try { store.init(); } catch (e) { report("store", e); }
  const s = S();
  lastSettings = s;
  intents.setAnrede(store.anrede());

  hud.init(hudCallbacks);
  hud.setTheme(s.theme);
  hud.setBrand({ firma: s.firma, wohnort: s.wohnort, galaxyBrightness: s.galaxyBrightness, vorname: s.vorname });
  hud.restoreLog(store.logEntries());
  hud.renderTimers(store.timers());
  hud.renderKonto(store.konto());
  hud.renderTermine(store.konto());
  hud.setFocus(!!s.focus);
  hud.setWakeButton(!!s.wakeWord);
  if (Number.isInteger(s.deckPage)) hud.goToPage(s.deckPage, false);
  const rm = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  hud.setReducedMotion(!!rm?.matches);
  rm?.addEventListener?.("change", (ev) => hud.setReducedMotion(!!ev.matches));

  sheets.init(sheetCallbacks);
  intents.setDevice?.(deviceNoun());
  voice.init({ settings: () => store.settings() });
  ears.init(earHandlers, { settings: () => store.settings(), audioContext: () => voice.audioContext() });
  ears.setTimings(timingsFrom(s));
  wireVoice();
  onStoreTopics();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("popstate", onPopState);
  window.addEventListener("pageshow", (e) => { if (e.persisted && booted && S().listenOnOpen) wakeFromOutside(); });
  voice.on("end", () => { if (state === "idle" && !listening) resumeIdle(); });   // Weckwort erst nach dem Sprechen
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("click", onSetupLinkClick, true);
  document.addEventListener("pointerdown", activity, { capture: true, passive: true });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  setInterval(tick, TICK_MS);

  if (imp.error) hud.toast("Der Setup-Link ist beschädigt.", 4000);
  // Setup-Link (#cfg=): erst fragen, dann übernehmen – ein fremder Link darf nicht still Schlüssel, Notizen oder
  // Kurzbefehle tauschen (security-privacy-1). Solange die Frage offen ist: normaler Start ohne Begrüßung.
  importPending = imp.pending || null;
  if (importPending) safe(() => sheets.open("import", { payload: importPending }), null);

  // „Beim Öffnen zuhören“ gilt auch beim Kaltstart (iOS beendet die Home-Bildschirm-App oft im Hintergrund)
  bootReason = importPending ? "normal"
    : imp.wake || WAKE_PARAM || s.listenOnOpen ? "wake" : s.startInBackground ? "background" : "normal";
  if (bootReason === "normal") {
    hud.showBoot("SYSTEME WERDEN HOCHGEFAHREN …");
    setTimeout(() => {
      hud.showBoot("SYSTEME BEREIT");
      setTimeout(() => hud.showBoot(null), BOOT_HIDE_MS);
    }, BOOT_READY_MS);
  }
  setState("loading", "Systeme werden hochgefahren …");
  hud.start();
  updateStatus();
  installUnlockListeners();                                   // jedes erste Tippen schaltet frei (§4.3)

  locked.audio = !(await voice.tryAutoUnlock().catch(() => false));
  if (s.wakeWord) {
    const ws = await ears.startWake().catch(() => "error");
    locked.mic = ws === "blocked";
  } else locked.mic = false;
  updateStatus();

  if (bootReason === "wake") {
    continueBoot("wake");                                     // wakeFromOutside zeigt bei Bedarf selbst den Fänger
    return;
  }
  // Fänger nur, wenn er gebraucht wird: Mikrofon gesperrt, oder Ton gesperrt und gleich kommt die Begrüßung.
  // Sonst meldet voice „blocked“, sobald Jarvis wirklich etwas sagen will (dann „Tippen, um die Antwort zu hören“).
  const needTap = locked.mic || (locked.audio && bootReason === "normal" && !!s.greeting);
  if (needTap) {
    pendingAfterUnlock = bootReason === "background" ? "background" : "greeting";
    if (bootReason === "background") {
      setState("idle", "Bereit.");
      enterStealth({ silent: true });
    }
    showUnlockCatcher(false);
    return;
  }
  removeUnlockListeners();
  continueBoot(bootReason);
}

init().catch((e) => {
  report("init", e);
  try {
    booted = true;
    setState("idle", "Bereit.");
    hud.showBoot(null);
  } catch { /* ignore */ }
});
