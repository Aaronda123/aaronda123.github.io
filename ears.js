// ==============================================================================================================
// CONTRACT – ears.js (owner: builder AUDIO). Spec: ARCHITECTURE.md §3.2.5, §3.5.1, §7.3.
// Imports: intents.js only. Settings and the AudioContext are injected via init(deps).
// export const TIMINGS   { silenceMs 900, unsureMs 1500, hesitationMs 2000, closeTailMs 1000, closeHoldMs 1800, closeMaxMs 5000,
//                          prehideStableMs 250, maxMs 50000, noSpeechMs 6000, followUpMs 4000, bareNameMs 1300,
//                          tickMs 80, stopGraceMs 400, restartBackoffMs [250 … 8000] }
// export function init(handlers, deps)
//   handlers { onWake(hit, listening), onPartial(text), onLevel(level), onPrehide(text), onPhase("transcribing"),
//              onWakeState(state), onEngine(name), onLog(kind, text) }
//   deps     { settings: () => Settings, audioContext: () => AudioContext | null }
// export function capabilities(): { native, azure, standalone }
// export function engine(): "native"|"azure"|"keyboard"
// export function setTimings(partial)
// export function wakeState(): "off"|"starting"|"on"|"paused"|"blocked"|"unsupported"|"error"
// export async function startWake(): Promise<WakeState>;  export function pauseWake(); resumeWake(); stopWake()
// export function unlockInGesture(): Promise<boolean>     (call synchronously inside a tap handler)
// export function listen({ followUp, seconds }?): { promise: Promise<ListenResult>, finish(), cancel() }
//   seconds: eigene Wartezeit fürs Nachhören (Plaudern: 6 s statt followUpMs)
// export function isListening(): boolean;  export function cancel()
// export function blockReason(): "mic"|"service"|null   why native recognition is refused (service = Siri/Diktat aus)
// export function micPermission(): "granted"|"denied"|"prompt"|null   Permissions API state of the microphone (cached)
// A "mic" block is retried when the permission turns "granted" and on every return to the page (robustness-1); a
// recognizer opened in a tap is not aborted before its onstart (pauseWake lets it finish the permission handshake).
// export function joinResults(results): string            transcript of a SpeechRecognitionResultList (Android dedup)
// One SpeechRecognition instance at a time; a wake hit hands the SAME session over as the command (D4, bug 21).
// ==============================================================================================================
// Jarvis' Ohren. Erste Wahl ist die Spracherkennung von iOS (live mitlesbar, Weckwort im selben Durchgang).
// Ist sie gesperrt, nimmt Jarvis selbst auf (echte Pegel treiben die Kugel) und schickt die Aufnahme an
// Azure Speech, sofern ein Azure-Schlüssel eingetragen ist. Sonst bleibt die Tastatur.
// Satzende wie am Mac seit 13.10. abends (Listener._record + speech_end_kind): bricht der Satz mittendrin ab („… und“,
// „äh“, „dass ich“) → 2,0 s; Schließen-Befehl → 1,0 s; klingt er unsicher (Artikel am Ende, ein Wort) → 1,5 s; klingt er
// fertig → 0,9 s. (Die Vorab-Erkennung des Mac entfällt: die Spracherkennung des Geräts erkennt schon live mit.)
// Android: Chrome beendet jede Erkennung nach ein paar Sekunden Stille und piept bei jedem Start. Darum wartet
// Jarvis dort zwischen zwei Durchgängen mit einem eigenen, lautlosen Mikrofon-Pegel auf Stimme und startet die
// Erkennung erst dann (sonst piept das Handy auf dem Nachttisch alle paar Sekunden).
import { matchWake, norm, speechEndKind, endsWithHide } from "./intents.js";

export const TIMINGS = Object.freeze({
  silenceMs: 900, unsureMs: 1500, hesitationMs: 2000, closeTailMs: 1000, closeHoldMs: 1800, closeMaxMs: 5000,
  prehideStableMs: 250, maxMs: 50000, noSpeechMs: 6000, followUpMs: 4000, bareNameMs: 1300,
  tickMs: 80, stopGraceMs: 400, restartBackoffMs: Object.freeze([250, 500, 1000, 2000, 4000, 8000]),
});

// Log lines (§5.3). Only wake-session problems are logged here; a listening session reports its error in the
// ListenResult and the app logs the matching line (§4.7), so nothing is logged twice (bug 10).
const LOG = {
  noWake: "Wake-Word geht hier nicht. Tipp auf die Kugel zum Sprechen.",
  network: "Die Spracherkennung braucht Internet.",
  noMic: "Ich finde kein Mikrofon.",
};

const START_RETRIES = 3;            // start() exceptions: retried, never "broken" (bug 20)
const START_RETRY_MS = 300;
const SHORT_SESSION_MS = 1500;      // shorter → backoff step up
const LONG_SESSION_MS = 5000;       // longer → backoff reset
const AUDIO_CAPTURE_RETRY_MS = 8000;
const UNLOCK_WAIT_MS = 1500;
const START_WAIT_MS = 1500;
const ERROR_END_WATCH_MS = 1000;    // iOS sometimes skips onend after onerror
const WAKE_WINDOW = 240;            // chars of a long wake transcript that are examined
const LEVEL_MS = 70;
const STT_TIMEOUT_MS = 15000;
const PRE_ROLL_BUFFERS = 4;         // ≈ 0.35 s before the voice onset (Azure recording)
const DENIED = new Set(["not-allowed", "service-not-allowed"]);
const NETWORK_DEAD_AFTER = 3;       // Brave & Co.: SpeechRecognition ohne Google-Dienst endet immer mit "network"
const GATE_TICK_MS = 60;
const GATE_CALIBRATE_MS = 400;
const ANDROID_RETRY_MS = 3000;      // Android ohne Pegel-Wächter: längere Pause nach einem stillen Durchgang
const ANDROID_RETRY_MAX_MS = 30000; // … wird verdoppelt, solange der Wächter nicht laufen kann (Ton gesperrt, robustness-13)
const LEAD_SEP = /^[\s,.!?:;-]+/u;
const STT_ALIAS = Object.freeze({
  silenceSeconds: "silenceMs", unsureSeconds: "unsureMs", hesitationSeconds: "hesitationMs", maxRecordSeconds: "maxMs",
  noSpeechSeconds: "noSpeechMs", followUpSeconds: "followUpMs",
});

const T = { ...TIMINGS, restartBackoffMs: [...TIMINGS.restartBackoffMs] };

let H = {};                 // handlers
let D = {};                 // deps
let inited = false;

let wantWake = false;       // the app wants the wake word
let paused = false;         // wake paused by the app (D5) or by the end of a listening session
let blocked = false;        // native recognition refused (not-allowed / service-not-allowed)
let blockedBy = null;       // "mic" (not-allowed) | "service" (service-not-allowed: Siri/Diktat aus, Dienst weg)
let netFails = 0;           // aufeinanderfolgende Durchgänge, die nur mit "network" endeten (online)
let nativeDead = false;     // für diesen Seitenaufruf unbrauchbar (Browser ohne Erkennungsdienst)
let gate = null;            // Android: Pegel-Wächter zwischen zwei Erkennungen
let gateFails = 0;          // Wächter konnte nicht laufen (z. B. Ton vor dem ersten Tippen gesperrt): länger warten
let gateRetry = null;        // Neustart-Timer, den der Wächter mangels Ton-Freigabe gestellt hat
let gateAudioHook = null;    // AudioContext, auf dessen Freigabe (erstes Tippen) der Wächter wartet
let micPerm = null;         // Permissions API: "granted" | "denied" | "prompt" | null (unbekannt)
let wState = "off";
let lastEngine = null;
const stateWaiters = [];
const logged = new Set();

let cur = null;             // the one live recognizer session
let dying = null;           // resolves when the last aborted recognizer has ended (≤ stopGraceMs)
let sessionSeq = 0;
let restartTimer = null;
let wakeToken = 0;          // generation token of wake start attempts
let backoffIdx = 0;

let cmd = null;             // the open listening session (command)
let cmdSeq = 0;
let ownCtx = null;          // private AudioContext if the app has none yet (Azure recording only)

// ---------------------------------------------------------------------------------------------- helpers
function call(name, ...args) {
  const fn = H && H[name];
  if (typeof fn !== "function") return undefined;
  try { return fn(...args); } catch { return undefined; }
}

function getSR() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/** Native Erkennung vorhanden und nicht als unbrauchbar erkannt. */
function srOk() {
  return !!getSR() && !nativeDead;
}

function isAndroid() {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");
}

function online() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function settingsNow() {
  try { return (D.settings && D.settings()) || {}; } catch { return {}; }
}

function azureKey() { return String(settingsNow().azureKey || "").trim(); }

function azureAvailable() {
  return !!azureKey() && typeof navigator !== "undefined" && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === "function";
}

function isVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function isStandalone() {
  try { if (typeof navigator !== "undefined" && navigator.standalone === true) return true; } catch { /* ignore */ }
  try { return !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches); } catch { return false; }
}

function safeNorm(text) {
  const t = String(text || "");
  try { return String(norm(t) || ""); } catch {
    return t.toLowerCase().replace(/[^\p{L}\p{N}_%\s]/gu, " ").replace(/\s+/g, " ").trim();
  }
}

function test(fn, text) {
  try { return !!fn(text); } catch { return false; }
}

function safeKind(text) {
  try { return speechEndKind(text); } catch { return "unsicher"; }
}

function safeMatchWake(text) {
  try { return matchWake(text) || null; } catch { return null; }
}

function collapse(text) { return String(text || "").replace(/\s+/g, " ").trim(); }

function wordCount(text) { return (String(text || "").match(/[\p{L}\p{N}_]+/gu) || []).length; }

function skipWords(text, n) {
  if (n <= 0) return text;
  const re = /[\p{L}\p{N}_]+/gu;
  let m, k = 0, end = 0;
  while (k < n && (m = re.exec(text))) { k++; end = m.index + m[0].length; }
  return k < n ? "" : text.slice(end);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function logOnce(tag, text) {
  if (logged.has(tag)) return;
  logged.add(tag);
  call("onLog", "system", text);
}

function setWakeState(s) {
  if (s === wState) return;
  wState = s;
  call("onWakeState", s);
  if (s !== "starting") flushStateWaiters();
}

function flushStateWaiters() {
  const list = stateWaiters.splice(0);
  for (const w of list) { clearTimeout(w.timer); w.resolve(wState); }
}

function waitState(ms = START_WAIT_MS) {
  return new Promise((resolve) => {
    if (wState !== "starting") { resolve(wState); return; }
    const w = { resolve, timer: null };
    w.timer = setTimeout(() => {
      const i = stateWaiters.indexOf(w);
      if (i >= 0) stateWaiters.splice(i, 1);
      resolve(wState);
    }, ms);
    stateWaiters.push(w);
  });
}

function reportEngine() {
  const e = engine();
  if (e === lastEngine) return;
  lastEngine = e;
  call("onEngine", e);
}

function canRunWake() {
  return wantWake && !paused && !blocked && srOk() && !cmd && isVisible();
}

// Gesperrt nur, weil der Sprachdienst fehlte (Siri/Diktat aus, offline): beim Zurückkehren / Netz neu versuchen
function retryService() {
  if (!blocked || blockedBy !== "service") return;
  blocked = false;
  blockedBy = null;
  reportEngine();
  if (!wantWake) return;
  if (wState === "blocked") setWakeState(paused || cmd ? "paused" : "starting");
  if (canRunWake() && !cur) {
    backoffIdx = 0;
    startWakeSession(0);
  }
}

// Gesperrt, weil das Mikrofon verweigert war: ist es jetzt erlaubt (Einstellungen geändert), neu starten (robustness-1)
function retryMic() {
  if (!blocked || blockedBy !== "mic") return;
  blocked = false;
  blockedBy = null;
  reportEngine();
  if (!wantWake) return;
  if (wState === "blocked") setWakeState(paused || cmd ? "paused" : "starting");
  if (canRunWake() && !cur) {
    backoffIdx = 0;
    startWakeSession(0);
  }
}

function watchMicPermission() {
  try {
    const q = typeof navigator !== "undefined" && navigator.permissions && navigator.permissions.query;
    if (typeof q !== "function") return;
    navigator.permissions.query({ name: "microphone" }).then((st) => {
      micPerm = st.state || null;
      const onChange = () => {
        micPerm = st.state || null;
        if (micPerm === "granted") retryMic();
      };
      if (typeof st.addEventListener === "function") st.addEventListener("change", onChange);
      else st.onchange = onChange;
    }, () => { micPerm = null; });
  } catch { micPerm = null; }
}

/** Bei der Rückkehr auf die Seite: Berechtigung neu lesen; erlaubt (oder unbekannt) → einmal neu versuchen. */
function recheckMic() {
  if (!blocked || blockedBy !== "mic") return;
  let p = null;
  try {
    if (typeof navigator !== "undefined" && navigator.permissions && typeof navigator.permissions.query === "function") {
      p = navigator.permissions.query({ name: "microphone" });
    }
  } catch { p = null; }
  if (!p) { retryMic(); return; }
  p.then((st) => {
    micPerm = st.state || null;
    if (micPerm !== "denied") retryMic();
  }, () => retryMic());
}

function reviveNative() {
  netFails = 0;
  if (!nativeDead) return;
  nativeDead = false;
  logged.delete("network");
  reportEngine();
  if (wantWake && wState === "unsupported") {
    setWakeState(paused || cmd ? "paused" : "starting");
    if (canRunWake() && !cur) startWakeSession(0);
  }
}

// Ein Durchgang endete nur mit "network" (ohne Ergebnis): nach NETWORK_DEAD_AFTER in Folge gilt die Erkennung hier
// als nicht verfügbar (z. B. Brave); online-Ereignis oder Rückkehr auf die Seite probieren es neu.
function countNetwork(s) {
  if (s.error === "network" && !s.gotResult && online()) {
    netFails++;
    if (netFails >= NETWORK_DEAD_AFTER && !nativeDead) {
      nativeDead = true;
      stopGate();
      reportEngine();
      if (wantWake) setWakeState("unsupported");
    }
  } else if (s.gotResult || !s.error) netFails = 0;
}

// ---------------------------------------------------------------------------------------------- public API
export function init(handlers = {}, deps = {}) {
  H = handlers || {};
  D = deps || {};
  if (!inited) {
    inited = true;
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", onVisibility);
    }
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("online", () => { reviveNative(); retryService(); });
    }
    watchMicPermission();
  }
  lastEngine = null;
  reportEngine();
}

export function capabilities() {
  return { native: srOk(), azure: azureAvailable(), standalone: isStandalone() };
}

export function engine() {
  if (srOk() && !blocked) return "native";
  if (azureAvailable()) return "azure";
  return "keyboard";
}

export function setTimings(partial = {}) {
  for (const [k, v] of Object.entries(partial || {})) {
    if (k === "restartBackoffMs") {
      if (Array.isArray(v) && v.length && v.every((n) => Number.isFinite(n) && n >= 0)) T.restartBackoffMs = v.slice();
      continue;
    }
    const key = Object.prototype.hasOwnProperty.call(TIMINGS, k) ? k : STT_ALIAS[k];
    if (!key) continue;
    let n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    if (STT_ALIAS[k]) n *= 1000;
    T[key] = n;
  }
}

export function wakeState() { return wState; }

export function isListening() { return !!cmd; }

/** Warum die native Erkennung gesperrt ist: "mic" (Mikrofon verweigert) | "service" (Sprachdienst aus) | null. */
export function blockReason() { return blocked ? blockedBy || "mic" : null; }

/** @returns {"granted"|"denied"|"prompt"|null} */
export function micPermission() { return micPerm; }

/**
 * Text einer SpeechRecognitionResultList. Chrome auf Android liefert im continuous-Modus kumulative Ergebnisse
 * („wie“, „wie spät“, „wie spät ist es“): ein Ergebnis, mit dessen Text das nächste beginnt, fällt weg.
 * @param {ArrayLike<any>} results
 * @returns {string}
 */
export function joinResults(results) {
  const list = Array.from(results || [], (r) => collapse((r && r[0] && r[0].transcript) || ""));
  const keys = list.map((t) => safeNorm(t));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (!list[i]) continue;
    const k = keys[i];
    const next = keys[i + 1];
    if (k && next && next.length >= k.length && (next === k || next.startsWith(`${k} `))) continue;
    out.push(list[i]);
  }
  return collapse(out.join(" "));
}

export async function startWake() {
  wantWake = true;
  paused = false;
  if (!srOk()) {
    if (wState !== "unsupported") {
      setWakeState("unsupported");
      if (azureAvailable()) call("onLog", "system", LOG.noWake);   // sonst meldet app, dass hier nur Tippen geht
    }
    reportEngine();
    return wState;
  }
  if (blocked) { setWakeState("blocked"); return wState; }
  if (cmd) { setWakeState("paused"); return wState; }          // resumed by the app after the turn
  if (cur && !cur.dead) {
    if (cur.mode === "unlock") cur.mode = "wake";               // the recognizer of the unlock tap stays (§4.3)
    if (cur.mode === "wake") {
      if (cur.gotStart) { setWakeState("on"); return wState; }
      if (wState !== "on") setWakeState("starting");
      return waitState();
    }
  }
  if (!isVisible()) { setWakeState("paused"); return wState; }
  backoffIdx = 0;
  setWakeState("starting");
  startWakeSession(0);
  return waitState();
}

export function pauseWake() {
  paused = true;
  wakeToken++;
  stopGate();
  clearTimeout(restartTimer);
  restartTimer = null;
  if (cur && cur.mode === "wake") {
    // gerade im Tippen gestartet und noch nicht angelaufen: erst die Erlaubnis abschließen lassen, dann beenden –
    // sonst schlägt das Freischalten fehl und das Mikrofon bleibt gesperrt (robustness-1)
    if (cur.gesture && !cur.gotStart && !cur.ended) cur.mode = "unlock";
    else stopCurrent();
  }
  if (wantWake && (wState === "on" || wState === "starting" || wState === "error")) setWakeState("paused");
}

export function resumeWake() {
  if (!wantWake) return;
  paused = false;
  if (!srOk() || blocked || cmd) return;
  if (cur && !cur.dead && (cur.mode === "wake" || cur.mode === "unlock")) {
    cur.mode = "wake";                                   // the unlock recognizer simply stays on
    if (cur.gotStart) setWakeState("on");
    return;
  }
  if (!isVisible()) { setWakeState("paused"); return; }
  backoffIdx = 0;
  clearTimeout(restartTimer);
  restartTimer = null;
  if (wState !== "on") setWakeState("starting");
  startWakeSession(0);                    // waits for a recognizer that is still ending (bug 22)
}

export function stopWake() {
  wantWake = false;
  paused = false;
  wakeToken++;
  stopGate();
  clearTimeout(restartTimer);
  restartTimer = null;
  if (cur && (cur.mode === "wake" || cur.mode === "unlock")) stopCurrent();
  setWakeState("off");
}

export function cancel() {
  if (cmd) endCommand(cmd, "cancelled");
}

export function unlockInGesture() {
  if (!srOk()) return Promise.resolve(false);
  stopGate();
  const s0 = settingsNow();
  // The recognizer of this tap becomes the wake session only if the wake word is wanted and not paused by
  // the app (D5: no open mic while Jarvis thinks or speaks); otherwise it is aborted right after onstart.
  const wake = (typeof s0.wakeWord === "boolean" ? s0.wakeWord : wantWake) && !paused && !cmd;
  if (cur && !cur.dead && cur.gotStart) {           // already listening: nothing to unlock
    if (wake && cur.mode === "unlock") cur.mode = "wake";
    return Promise.resolve(true);
  }
  if (cmd && cmd.engine === "native" && cur && !cur.dead) return Promise.resolve(true);
  if (wake) wantWake = true;
  wakeToken++;
  clearTimeout(restartTimer);
  restartTimer = null;
  if (cur) {                                         // a start without gesture that never came up: replace it here
    const old = cur;
    cur = null;
    old.dead = true;
    try { old.rec.abort(); } catch { /* ignore */ }
  }
  return new Promise((resolve) => {
    let settled = false;
    let s = null;
    let timer = null;
    const fin = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // No answer within 1.5 s and no error: the permission prompt is probably still open → not blocked.
    timer = setTimeout(() => fin(!!s && !s.ended && !s.error), UNLOCK_WAIT_MS);
    const attempt = (n) => {
      if (settled) return;
      try {
        s = openSession(wake ? "wake" : "unlock", null);
        s.gesture = true;
        const mine = s;
        mine.onStarted = () => {
          fin(true);
          if (mine.mode === "unlock" && cur === mine) stopCurrent();
        };
        mine.onEndedCb = () => fin(mine.gotStart);
        if (mine.mode === "wake" && wState !== "on") setWakeState("starting");
      } catch {
        s = null;
        if (n < START_RETRIES) setTimeout(() => attempt(n + 1), START_RETRY_MS);
        else fin(false);
      }
    };
    attempt(0);
  });
}

export function listen({ followUp = false, seconds = 0 } = {}) {
  wakeToken++;
  stopGate();
  clearTimeout(restartTimer);
  restartTimer = null;
  const eng = engine();
  reportEngine();
  const c = newCommand({ followUp, fromWake: false });
  if (followUp && Number(seconds) > 0) c.followMs = Math.min(30000, Number(seconds) * 1000);
  if (wantWake && (wState === "on" || wState === "starting" || wState === "error")) setWakeState("paused");
  if (eng === "native") {
    startLevelSim(c);
    startCommandSession(c, 0);
  } else if (eng === "azure") {
    if (cur) stopCurrent();
    startAzure(c);
  } else {
    endCommand(c, "error", { error: { code: "unavailable", message: "Keine Spracherkennung verfügbar" } });
  }
  return c.listening;
}

// ---------------------------------------------------------------------------------------------- recognizer
function openSession(mode, c) {
  const SRc = getSR();
  const rec = new SRc();
  rec.lang = "de-DE";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  const s = {
    id: ++sessionSeq, rec, mode, cmd: c, startedAt: Date.now(), gotStart: false, ended: false, dead: false,
    error: null, transcript: "", consumed: 0, endWaiters: [], endWatch: null, onStarted: null, onEndedCb: null,
    gotResult: false,
  };
  rec.onstart = () => onStart(s);
  rec.onaudiostart = () => onStart(s);
  rec.onresult = (e) => onResult(s, e);
  rec.onerror = (e) => onError(s, e);
  rec.onend = () => onEnd(s);
  cur = s;
  try {
    rec.start();
  } catch (err) {
    if (cur === s) cur = null;
    s.dead = true;
    s.ended = true;
    rec.onstart = rec.onaudiostart = rec.onresult = rec.onerror = rec.onend = null;
    throw err;
  }
  return s;
}

/** Abort the live recognizer; the promise resolves on its onend (max stopGraceMs). */
function stopCurrent() {
  const s = cur;
  if (!s) return dying || Promise.resolve();
  cur = null;
  s.dead = true;
  const ended = new Promise((res) => {
    if (s.ended) { res(); return; }
    s.endWaiters.push(res);
    setTimeout(res, T.stopGraceMs);
  });
  try { s.rec.abort(); } catch {
    try { s.rec.stop(); } catch { /* ignore */ }
  }
  const prev = dying;
  const d = Promise.all([ended, prev]).then(() => { if (dying === d) dying = null; });
  dying = d;
  return d;
}

function onStart(s) {
  if (s.dead || s.gotStart) return;
  s.gotStart = true;
  logged.delete("nomic");
  if (blocked) {
    blocked = false;
    blockedBy = null;
    reportEngine();
    if (wState === "blocked") setWakeState(s.mode === "wake" ? "on" : "paused");
  }
  if (s.mode === "wake") setWakeState("on");
  const c = s.cmd;
  if (s.mode === "command" && c && !c.done && !c.fromWake && !c.voiced && c.restarts === 0) c.startAt = Date.now();
  if (s.onStarted) { const f = s.onStarted; s.onStarted = null; f(); }
}

function onResult(s, e) {
  if (s.dead) return;
  let t = "";
  try {
    t = joinResults((e && e.results) || []);
  } catch { return; }
  if (!s.gotStart) onStart(s);
  if (s.dead) return;
  s.transcript = t;
  if (t) s.gotResult = true;
  netFails = 0;
  logged.delete("network");
  if (s.mode === "wake") wakeResult(s, t);
  else if (s.mode === "command" && s.cmd) commandResult(s.cmd, t);
}

function onError(s, e) {
  if (s.dead || s.ended) return;
  const code = String((e && (e.error || e.message)) || "unknown");
  s.error = code;
  if (DENIED.has(code)) {
    blocked = true;
    blockedBy = code === "service-not-allowed" ? "service" : "mic";
    reportEngine();
    if (wantWake) setWakeState("blocked");
  }
  clearTimeout(s.endWatch);
  s.endWatch = setTimeout(() => onEnd(s), ERROR_END_WATCH_MS);
}

function onEnd(s) {
  if (s.ended) return;
  s.ended = true;
  clearTimeout(s.endWatch);
  const rec = s.rec;
  rec.onstart = rec.onaudiostart = rec.onresult = rec.onerror = rec.onend = null;
  const waiters = s.endWaiters.splice(0);
  for (const w of waiters) w();
  if (s.dead) return;
  s.dead = true;
  if (cur === s) cur = null;
  countNetwork(s);
  if (s.onEndedCb) { const f = s.onEndedCb; s.onEndedCb = null; f(); }
  if (s.mode === "command") commandSessionEnded(s);
  else if (s.mode === "wake") wakeSessionEnded(s);
}

// ---------------------------------------------------------------------------------------------- wake word
async function startWakeSession(attempt = 0) {
  const token = ++wakeToken;
  stopGate();
  if (!canRunWake() || (cur && !cur.dead)) return;
  if (dying) {
    await dying;
    if (token !== wakeToken || !canRunWake() || (cur && !cur.dead)) return;
  }
  if (wState !== "on") setWakeState("starting");
  try {
    openSession("wake", null);
  } catch {
    clearTimeout(restartTimer);
    if (attempt < START_RETRIES) {
      restartTimer = setTimeout(() => { restartTimer = null; startWakeSession(attempt + 1); }, START_RETRY_MS);
    } else {
      scheduleWake(nextDelay(0));                       // keep trying, never mark native broken (bug 20)
    }
  }
}

function scheduleWake(delay) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => { restartTimer = null; startWakeSession(0); }, Math.max(0, delay));
}

function nextDelay(lived) {
  if (lived > LONG_SESSION_MS) backoffIdx = 0;
  const list = T.restartBackoffMs;
  const d = list[Math.min(backoffIdx, list.length - 1)];
  if (lived < SHORT_SESSION_MS) backoffIdx++;
  return d;
}

function wakeSessionEnded(s) {
  const lived = Date.now() - s.startedAt;
  const err = s.error;
  if (err && DENIED.has(err)) return;                   // blocked: unlockInGesture() (service: also visible/online)
  if (!wantWake) { setWakeState("off"); return; }
  if (nativeDead) return;                               // countNetwork hat "unsupported" gemeldet
  if (err === "audio-capture") {
    logOnce("nomic", LOG.noMic);
    setWakeState("error");
    if (!paused && !cmd) scheduleWake(AUDIO_CAPTURE_RETRY_MS);
    return;
  }
  if (err === "network") logOnce("network", LOG.network);
  if (!canRunWake()) {
    if (wState === "on" || wState === "starting") setWakeState("paused");
    return;
  }
  if (isAndroid() && (!err || err === "no-speech" || err === "aborted")) {
    startGate();                                        // lautlos auf Stimme warten, dann erst neu starten (piept)
    return;
  }
  scheduleWake(nextDelay(lived));
}

// ---------------------------------------------------------------------------------------------- Android: Pegel-Wächter
function stopGate() {
  const g = gate;
  if (!g) return;
  gate = null;
  g.dead = true;
  clearInterval(g.timer);
  try { if (g.src) g.src.disconnect(); } catch { /* ignore */ }
  stopTracks(g.stream);
}

async function startGate() {
  stopGate();
  const token = wakeToken;
  const g = { token, stream: null, src: null, an: null, buf: null, timer: 0, noise: [], thr: 0.02, loud: 0, startAt: 0, dead: false };
  gate = g;
  const fallback = (audioLocked = false) => {
    if (gate === g) gate = null;
    // ohne Wächter piept jeder Neustart: je öfter er nicht laufen kann, desto länger warten (robustness-13)
    gateFails++;
    const ms = Math.min(ANDROID_RETRY_MAX_MS, ANDROID_RETRY_MS * 2 ** Math.max(0, gateFails - 1));
    if (!g.dead && token === wakeToken && canRunWake() && !cur) {
      scheduleWake(ms);
      gateRetry = restartTimer;
      if (audioLocked) gateOnAudio(ctx);                // erstes Tippen gibt den Ton frei: dann gleich lautlos lauschen
    }
  };
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
  const ctx = audioCtx();
  if (!md || typeof md.getUserMedia !== "function" || !ctx) { fallback(); return; }
  if (ctx.state !== "running") {
    try { await Promise.race([Promise.resolve(ctx.resume()).catch(() => {}), sleep(300)]); } catch { /* ignore */ }
  }
  if (g.dead) return;
  if (ctx.state !== "running") { fallback(true); return; }   // ohne Ton-Freigabe misst Web Audio nichts
  let stream;
  try {
    stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch { fallback(); return; }
  if (g.dead || token !== wakeToken || !canRunWake() || cur) {
    stopTracks(stream);
    if (gate === g) gate = null;
    return;
  }
  try {
    g.stream = stream;
    g.src = ctx.createMediaStreamSource(stream);
    g.an = ctx.createAnalyser();
    g.an.fftSize = 1024;
    g.src.connect(g.an);
    g.buf = new Float32Array(g.an.fftSize);
  } catch { stopGate(); fallback(); return; }
  g.startAt = Date.now();
  gateFails = 0;
  g.timer = setInterval(() => gateTick(g), GATE_TICK_MS);
}

// Der Ton war gesperrt (Android-Tab vor dem ersten Tippen): sobald er frei ist, nicht erst den gestreckten Neustart
// abwarten (bis 30 s taub), sondern sofort den lautlosen Wächter starten – ohne Piepen (robustness-13)
function gateOnAudio(ctx) {
  if (!ctx || gateAudioHook === ctx || typeof ctx.addEventListener !== "function") return;
  gateAudioHook = ctx;
  const onState = () => {
    if (ctx.state !== "running") return;
    try { ctx.removeEventListener("statechange", onState); } catch { /* ignore */ }
    if (gateAudioHook === ctx) gateAudioHook = null;
    if (!restartTimer || restartTimer !== gateRetry || gate || cur || !canRunWake()) return;
    clearTimeout(restartTimer);
    restartTimer = null;
    gateRetry = null;
    gateFails = 0;
    startGate();
  };
  try { ctx.addEventListener("statechange", onState); } catch { gateAudioHook = null; }
}

function gateTick(g) {
  if (gate !== g || g.dead) return;
  if (g.token !== wakeToken || !canRunWake() || cur) { stopGate(); return; }
  let rms = 0;
  try {
    g.an.getFloatTimeDomainData(g.buf);
    let sum = 0;
    for (let i = 0; i < g.buf.length; i++) sum += g.buf[i] * g.buf[i];
    rms = Math.sqrt(sum / Math.max(1, g.buf.length));
  } catch { stopGate(); scheduleWake(ANDROID_RETRY_MS); return; }
  if (Date.now() - g.startAt < GATE_CALIBRATE_MS) { g.noise.push(rms); return; }
  if (g.noise.length) { g.thr = noiseThreshold(g.noise); g.noise = []; }
  if (rms > g.thr) {
    if (++g.loud >= 2) {                                // Stimme: Erkennung starten (Mac: 2 laute Puffer)
      stopGate();
      backoffIdx = 0;
      startWakeSession(0);
    }
  } else g.loud = 0;
}

function onVisibility() {
  if (!isVisible()) {
    wakeToken++;
    stopGate();
    clearTimeout(restartTimer);
    restartTimer = null;
    if (cur && cur.mode === "wake") stopCurrent();
    if (wantWake && (wState === "on" || wState === "starting")) setWakeState("paused");
    return;
  }
  if (nativeDead) reviveNative();
  if (blocked && blockedBy === "service") { retryService(); return; }
  if (blocked && blockedBy === "mic") { recheckMic(); return; }
  if (canRunWake() && !cur) {
    backoffIdx = 0;
    if (wState !== "on") setWakeState("starting");
    startWakeSession(0);
  }
}

function wakeResult(s, t) {
  if (typeof H.onWake !== "function") return;
  const base = Math.min(t.length, Math.max(s.consumed, t.length - WAKE_WINDOW));
  const sl = t.slice(base);
  const hit = safeMatchWake(sl);
  if (!hit) return;
  const offset = base + restOffset(sl, hit);
  s.consumed = offset;
  // The SAME session continues as the command (D4, bug 21): text after the name is the command.
  const c = newCommand({ followUp: false, fromWake: true, hit });
  c.session = s;
  c.base = base;
  c.offset = offset;
  c.anchorNorm = safeNorm(t.slice(0, offset));
  c.anchorWords = wordCount(t.slice(0, offset));
  s.mode = "command";
  s.cmd = c;
  clearTimeout(restartTimer);
  restartTimer = null;
  setWakeState("paused");
  startLevelSim(c);
  call("onWake", hit, c.listening);
  if (!c.done) commandResult(c, t);
}

/** Index in `sl` where the rest after the matched name starts. */
function restOffset(sl, hit) {
  const rest = String((hit && hit.rest) || "");
  if (!rest) return sl.replace(/\s+$/u, "").length;
  const trimmed = sl.replace(/\s+$/u, "");
  if (trimmed.endsWith(rest)) return trimmed.length - rest.length;
  const i = sl.lastIndexOf(rest);
  return i >= 0 ? i : trimmed.length;
}

// ---------------------------------------------------------------------------------------------- listening
function newCommand({ followUp = false, fromWake = false, hit = null } = {}) {
  if (cmd) endCommand(cmd, "cancelled");               // only one open listening session
  const now = Date.now();
  const c = {
    id: ++cmdSeq, followUp: !!followUp, fromWake, hit, wakeAt: fromWake ? now : 0, startAt: now,
    engine: "native", session: null, base: 0, offset: 0, anchorNorm: null, anchorWords: 0, restarts: 0,
    liveText: "", lastNorm: "", lastChangeAt: now, voiced: false, hesitant: false, kind: "unsicher", close: false,
    followMs: 0,
    prehidden: false, hidAt: 0, boost: 0.15, done: false, tick: null, levelTimer: null, az: null,
    resolve: null, promise: null, listening: null,
  };
  c.promise = new Promise((res) => { c.resolve = res; });
  c.listening = {
    promise: c.promise,
    finish: () => finishCommand(c),
    cancel: () => endCommand(c, "cancelled"),
  };
  cmd = c;
  c.tick = setInterval(() => tickCommand(c), T.tickMs);
  return c;
}

function startLevelSim(c) {
  clearInterval(c.levelTimer);
  c.levelTimer = setInterval(() => {
    if (c.done) return;
    c.boost *= 0.85;
    call("onLevel", Math.min(1, 0.12 + c.boost + Math.random() * 0.08));
  }, LEVEL_MS);
}

function startCommandSession(c, attempt = 0) {
  if (c.done || cmd !== c) return;
  if (cur || dying) {                                   // one recognizer at a time (bug 20)
    const p = cur ? stopCurrent() : dying;
    p.then(() => startCommandSession(c, attempt));
    return;
  }
  try {
    c.session = openSession("command", c);
  } catch (err) {
    if (attempt < START_RETRIES) {
      setTimeout(() => startCommandSession(c, attempt + 1), START_RETRY_MS);
      return;
    }
    if (!c.voiced && azureAvailable()) { switchToAzure(c); return; }
    endCommand(c, "error", { error: { code: "unavailable", message: String((err && err.message) || err) } });
  }
}

function liveFrom(c, t) {
  if (!c.fromWake || c.anchorNorm === null) return collapse(t.replace(LEAD_SEP, ""));
  let rest;
  if (t.length >= c.offset && safeNorm(t.slice(0, c.offset)) === c.anchorNorm) {
    rest = t.slice(c.offset);
  } else {
    // iOS rewrote the part with the name ("Hey Jarvis" → "Hey, Jarvis,"): find the name again.
    const base = Math.min(c.base, t.length);
    const sl = t.slice(base);
    const hit = safeMatchWake(sl);
    if (hit) {
      c.offset = base + restOffset(sl, hit);
      c.anchorNorm = safeNorm(t.slice(0, c.offset));
      rest = t.slice(c.offset);
    } else {
      rest = skipWords(t, c.anchorWords);
    }
  }
  return collapse(rest.replace(LEAD_SEP, ""));
}

function commandResult(c, t) {
  if (c.done) return;
  const live = liveFrom(c, t);
  const n = safeNorm(live);
  c.boost = 0.55 + Math.random() * 0.35;
  if (n !== c.lastNorm) {
    c.lastNorm = n;
    c.lastChangeAt = Date.now();
    c.voiced = n !== "";
    c.kind = c.voiced ? (safeKind(live) || "unsicher") : "unsicher";   // offen | unsicher | fertig
    c.hesitant = c.kind === "offen";
    c.close = c.voiced && test(endsWithHide, n);
  }
  if (live !== c.liveText) {
    c.liveText = live;
    if (live) call("onPartial", live);
  }
}

// End-of-speech rules (§7.3, Mac Listener._record), evaluated every tickMs.
function tickCommand(c) {
  if (c.done) return;
  if (c.engine === "azure") { tickAzure(c); return; }
  const now = Date.now();
  if (c.close && !c.prehidden && now - c.lastChangeAt >= T.prehideStableMs) {
    c.prehidden = true;
    c.hidAt = now;
    call("onPrehide", c.liveText);
    if (c.done) return;
  }
  if (c.voiced) {
    const unsure = Math.max(T.silenceMs, T.unsureMs);
    const pause = c.kind === "offen" ? Math.max(unsure, T.hesitationMs)   // „spiel … äh …“: warten
      : c.close ? T.closeTailMs                                          // Schließen-Befehl: nur kurz auf einen Nachsatz
        : c.kind === "unsicher" ? unsure : T.silenceMs;
    if (now - c.lastChangeAt >= pause) {
      endCommand(c, c.kind === "offen" ? "hesitation" : c.close ? "close" : c.kind === "unsicher" ? "unsure" : "silence");
      return;
    }
  }
  if (c.close && now - c.lastChangeAt >= T.closeHoldMs) { endCommand(c, "close_hold"); return; }
  if (c.prehidden && now - c.hidAt >= T.closeMaxMs) { endCommand(c, "close_max"); return; }
  if (now - c.startAt >= T.maxMs) { endCommand(c, "max"); return; }
  if (c.fromWake && !c.voiced && now - c.wakeAt >= T.bareNameMs) { endCommand(c, "bare"); return; }
  if (!c.voiced && now - c.startAt >= (c.followUp ? c.followMs || T.followUpMs : T.noSpeechMs)) endCommand(c, "nospeech");
}

function commandSessionEnded(s) {
  const c = s.cmd;
  if (!c || c.done || c.session !== s || c.engine !== "native") return;
  if (c.voiced) { endCommand(c, "silence"); return; }  // iOS ended the session: take what was said
  const err = s.error;
  if (err && DENIED.has(err)) {
    if (azureAvailable()) { switchToAzure(c); return; }
    const code = err === "service-not-allowed" ? "service" : "denied";
    endCommand(c, "error", { error: { code, message: `Spracherkennung gesperrt (${err})` } });
    return;
  }
  if (err === "audio-capture") { endCommand(c, "error", { error: { code: "nomic", message: "Kein Mikrofon" } }); return; }
  if (err === "network") {
    if (nativeDead && azureAvailable()) { switchToAzure(c); return; }
    endCommand(c, "error", { error: { code: nativeDead ? "unavailable" : "network", message: "Spracherkennung ohne Netz" } });
    return;
  }
  if (err === "language-not-supported") {
    endCommand(c, "error", { error: { code: "unavailable", message: "Deutsch wird nicht erkannt" } });
    return;
  }
  const limit = c.followUp ? c.followMs || T.followUpMs : T.noSpeechMs;
  if (c.restarts < 1 && Date.now() - c.startAt < limit && isVisible()) {
    c.restarts++;
    c.anchorNorm = null;                                 // the new recognizer starts with an empty transcript
    c.offset = 0;
    c.base = 0;
    startCommandSession(c, 0);
    return;
  }
  endCommand(c, c.fromWake ? "bare" : "nospeech");
}

function finishCommand(c) {
  if (!c || c.done) return;
  if (c.engine === "azure") { azureStop(c, "finished"); return; }
  endCommand(c, "finished");                            // D6: orb tap = "fertig"
}

function endCommand(c, reason, extra = {}) {
  if (!c || c.done) return;
  c.done = true;
  clearInterval(c.tick);
  clearInterval(c.levelTimer);
  c.tick = c.levelTimer = null;
  if (c.az) {
    azureTeardown(c);
    try { if (c.az.ctl) c.az.ctl.abort(); } catch { /* ignore */ }
  }
  call("onLevel", 0);
  let text = typeof extra.text === "string" ? extra.text : c.liveText;
  if (reason === "nospeech" || reason === "bare" || reason === "cancelled" || reason === "error") text = "";
  text = collapse(text);
  if (reason === "finished" && !safeNorm(text)) { reason = "cancelled"; text = ""; }
  const res = { text, reason, prehidden: c.prehidden, engine: c.engine };
  if (extra.error) res.error = extra.error;
  if (cmd === c) cmd = null;
  if (cur && cur.cmd === c) stopCurrent();
  if (wantWake && srOk() && !blocked && wState !== "unsupported") {
    paused = true;                                      // the app resumes the wake word when idle (D5)
    setWakeState("paused");
  }
  try { c.resolve(res); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------- Azure STT
function switchToAzure(c) {
  clearInterval(c.levelTimer);
  c.levelTimer = null;
  if (cur && cur.cmd === c) stopCurrent();
  reportEngine();
  startAzure(c);
}

function audioCtx() {
  let ctx = null;
  try { ctx = (D.audioContext && D.audioContext()) || null; } catch { ctx = null; }
  if (ctx) return ctx;
  if (ownCtx) return ownCtx;
  const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try { ownCtx = new AC(); } catch { ownCtx = null; }
  return ownCtx;
}

function stopTracks(stream) {
  try { if (stream) stream.getTracks().forEach((tr) => tr.stop()); } catch { /* ignore */ }
}

function startAzure(c) {
  c.engine = "azure";
  c.startAt = Date.now();
  const az = c.az = {
    stream: null, src: null, proc: null, sink: null, rate: 48000, chunks: [], pre: [], loud: 0, voiced: false,
    lastLoudAt: 0, noise: [], threshold: 0.012, calibrated: false, startAt: 0, stopping: false, ctl: null,
  };
  (async () => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    if (!md || typeof md.getUserMedia !== "function") {
      endCommand(c, "error", { error: { code: "unavailable", message: "Kein Mikrofonzugriff" } });
      return;
    }
    let stream;
    try {
      stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch (e) {
      const name = (e && e.name) || "";
      const code = name === "NotAllowedError" || name === "SecurityError" ? "denied" : "nomic";
      endCommand(c, "error", { error: { code, message: String((e && e.message) || name || "getUserMedia") } });
      return;
    }
    // A stop requested while the permission prompt was open is honoured now (bug 23).
    if (c.done || az.stopping) { stopTracks(stream); return; }
    az.stream = stream;
    const ctx = audioCtx();
    if (!ctx) {
      endCommand(c, "error", { error: { code: "unavailable", message: "Kein Web Audio" } });
      return;
    }
    if (ctx.state !== "running") {
      try { await Promise.race([Promise.resolve(ctx.resume()).catch(() => {}), sleep(300)]); } catch { /* ignore */ }
    }
    if (c.done || az.stopping) { stopTracks(stream); az.stream = null; return; }
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    az.src = src;
    az.proc = proc;
    az.sink = sink;
    az.rate = ctx.sampleRate || 48000;
    az.startAt = Date.now();
    c.startAt = az.startAt;
    proc.onaudioprocess = (e) => azureFrame(c, e);
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
  })().catch((e) => {
    endCommand(c, "error", { error: { code: "unavailable", message: String((e && e.message) || e) } });
  });
}

function noiseThreshold(noise) {
  // Mac start_recording: min(max(p20(noise) × 2.8, min_speech_level 0.012), 0.04)
  const floor = noise.length ? percentile(noise, 20) : 0.004;
  return Math.min(Math.max(floor * 2.8, 0.012), 0.04);
}

function percentile(values, p) {
  const a = values.slice().sort((x, y) => x - y);
  if (a.length === 1) return a[0];
  const pos = (a.length - 1) * (p / 100);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function azureFrame(c, e) {
  const az = c.az;
  if (c.done || !az || az.stopping) return;
  const data = e.inputBuffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / Math.max(1, data.length));
  const now = Date.now();
  if (!az.calibrated) {
    if (now - az.startAt < 300) az.noise.push(rms);
    else { az.calibrated = true; az.threshold = noiseThreshold(az.noise); }
  }
  call("onLevel", Math.min(1, rms * 12));               // Mac L3637
  const copy = new Float32Array(data);
  if (rms > az.threshold) {
    az.loud++;
    az.lastLoudAt = now;
    if (!az.voiced && az.loud >= 2) {                   // voiced = 2 loud buffers (Mac)
      az.voiced = true;
      c.voiced = true;
      az.chunks.push(...az.pre);
      az.pre = [];
    }
  }
  if (az.voiced) az.chunks.push(copy);
  else {
    az.pre.push(copy);
    if (az.pre.length > PRE_ROLL_BUFFERS) az.pre.shift();
  }
}

function tickAzure(c) {
  const az = c.az;
  if (!az || az.stopping) return;
  const now = Date.now();
  if (!az.startAt) {                                    // still waiting for getUserMedia (permission prompt)
    if (now - c.startAt >= T.maxMs) endCommand(c, "nospeech");
    return;
  }
  // ohne Live-Text gilt der Satz als „unsicher“ (Mac: ohne Vosk) → unsure_seconds
  if (az.voiced && now - az.lastLoudAt >= Math.max(T.silenceMs, T.unsureMs)) { azureStop(c, "silence"); return; }
  if (now - az.startAt >= T.maxMs) { azureStop(c, "max"); return; }
  if (!az.voiced && now - az.startAt >= (c.followUp ? c.followMs || T.followUpMs : T.noSpeechMs)) azureStop(c, "nospeech");
}

function azureTeardown(c) {
  const az = c.az;
  if (!az) return;
  try { if (az.proc) az.proc.onaudioprocess = null; } catch { /* ignore */ }
  for (const node of [az.src, az.proc, az.sink]) {
    try { if (node) node.disconnect(); } catch { /* ignore */ }
  }
  stopTracks(az.stream);
  az.stream = az.src = az.proc = az.sink = null;
}

function azureStop(c, reason) {
  const az = c.az;
  if (!az || az.stopping || c.done) return;
  az.stopping = true;
  const chunks = az.chunks;
  const rate = az.rate;
  azureTeardown(c);
  call("onLevel", 0);
  if (!az.voiced || !chunks.length) {
    endCommand(c, reason === "finished" || reason === "cancelled" ? "cancelled" : "nospeech");
    return;
  }
  call("onPhase", "transcribing");                      // app: state transcribing (bug 9)
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  az.ctl = ctl;
  const timer = setTimeout(() => { try { if (ctl) ctl.abort(); } catch { /* ignore */ } }, STT_TIMEOUT_MS);
  transcribe(chunks, rate, ctl ? ctl.signal : undefined)
    .then((text) => {
      clearTimeout(timer);
      if (!c.done) endCommand(c, reason, { text });
    })
    .catch((e) => {
      clearTimeout(timer);
      if (!c.done) endCommand(c, "error", { error: { code: "azure", message: String((e && e.message) || e) } });
    });
}

async function transcribe(chunks, rate, signal) {
  const s = settingsNow();
  const key = String(s.azureKey || "").trim();
  const region = /^[a-z0-9]{2,40}$/i.test(String(s.azureRegion || "").trim())
    ? String(s.azureRegion).trim() : "germanywestcentral";
  if (!key) throw new Error("Kein Azure-Schlüssel");
  const wav = encodeWav(chunks, rate, 16000);
  const res = await fetch(`https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=de-DE&format=simple`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
      Accept: "application/json",
    },
    body: wav,
    signal,
  });
  if (!res.ok) throw new Error(`Azure-Spracherkennung ${res.status}`);
  const data = await res.json();
  return data && data.RecognitionStatus === "Success" ? String(data.DisplayText || "").trim() : "";
}

function encodeWav(chunks, inRate, outRate) {
  const len = chunks.reduce((n, ch) => n + ch.length, 0);
  const input = new Float32Array(len);
  let off = 0;
  for (const ch of chunks) { input.set(ch, off); off += ch.length; }
  const ratio = Math.max(1, inRate / outRate);
  const outLen = Math.floor(len / ratio);
  const buf = new ArrayBuffer(44 + outLen * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + outLen * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, outRate, true); v.setUint32(28, outRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, outLen * 2, true);
  for (let i = 0; i < outLen; i++) {
    // Mittelwert-Downsampler, reicht für Sprache
    const a = Math.floor(i * ratio), b = Math.min(len, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += input[j];
    const x = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
