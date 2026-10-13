// ==============================================================================================================
// CONTRACT – voice.js (owner: builder AUDIO). Spec: ARCHITECTURE.md §3.2.6, §3.5.2.
// No imports. Settings are injected via init({ settings }).
// export const PRESETS        geraet (free device voice, default, CR1.2) · butler (de-DE-ConradNeural, -8 %, -6 Hz) · florian · killian · andrew
// export function warmPhrases(anrede, closing): string[]
// export function init({ settings })
// export function on(event, fn): () => void   events: start, chunk, end, level, warn, blocked, engine
// export function isUnlocked(); export async function tryAutoUnlock(); export function unlockInGesture()
// export function say(text); export function done(): Promise<void>; export function stop()
// export function isSpeaking(); export function setMuted(on); export function isMuted()
// export function usesAzure(); export function engineLabel(); export function resetAzure()
// export function chime(kind)                  "wake"|"done"|"error"|"timer" (Mac chimes)
// export function test(text, draft): Promise<void>   speaks once with unsaved values, saves nothing (bug 11)
// export async function prewarm(phrases): Promise<number>
// export function clean(text): string          also drops AKTION lines
// export function audioContext(): AudioContext | null
// Azure Neural TTS via Web Audio + analyser (orb bands), iOS voice fallback, TTS cache, playback watchdogs.
// ==============================================================================================================
// Jarvis' Stimme. Mit Azure-Schlüssel exakt die Stimme vom Mac (Microsoft Neural „Conrad“ = Butler),
// sonst die beste deutsche Stimme des Geräts (kostenlos, CR1.2). Satz für Satz: die Vertonung jedes Satzes beginnt beim say(),
// der erste klingt schon, während der Rest noch vertont wird. Web Audio + Analyser treibt die Kugel.
// Unterbrechungen (Anruf, Siri, App-Wechsel) lassen Jarvis nie in SPRICHT hängen (Watchdogs).

// Voreinstellungen (Mac voice/picker.html; Florian = ursprüngliche Mac-Einstellung +9 % / -5 Hz);
// sys = Einstellung für die Gerätestimme (speechSynthesis).
export const PRESETS = Object.freeze({
  // CHANGES-1 CR1.2: free device voice (speechSynthesis) is the default; never uses Azure.
  geraet: Object.freeze({ name: "Gerätestimme", voice: "", rate: 0, pitch: 0, free: true, sys: Object.freeze({ rate: 0.95, pitch: 0.85 }) }),
  butler: Object.freeze({ name: "Butler", voice: "de-DE-ConradNeural", rate: -8, pitch: -6, sys: Object.freeze({ rate: 0.9, pitch: 0.78 }) }),
  florian: Object.freeze({ name: "Florian", voice: "de-DE-FlorianMultilingualNeural", rate: 9, pitch: -5, sys: Object.freeze({ rate: 1.0, pitch: 0.9 }) }),
  killian: Object.freeze({ name: "Killian", voice: "de-DE-KillianNeural", rate: -5, pitch: -4, sys: Object.freeze({ rate: 0.95, pitch: 0.85 }) }),
  andrew: Object.freeze({ name: "Andrew", voice: "en-US-AndrewMultilingualNeural", rate: -6, pitch: -3, sys: Object.freeze({ rate: 0.95, pitch: 0.88 }) }),
});

// Warn lines (§5.3, kind "system" in the app).
const WARN_KEY = "Azure-Schlüssel oder Region stimmt nicht. Ich spreche mit der Gerätestimme.";
const WARN_DOWN = "Azure-Stimme gerade nicht erreichbar. Ich spreche mit der Gerätestimme.";

const CACHE_NAME = "jarvis-tts-v1";
const CACHE_MAX_CHARS = 80;          // Mac synthesize(): short phrases come from the cache
const DEGRADE_MS = 60000;            // network/CORS/429/5xx → iOS voice for 60 s (bug 26/29)
const TTS_TIMEOUT_MS = 10000;
const CANCEL_GAP_MS = 120;           // speechSynthesis drops an utterance spoken right after cancel() (bug 30)
const WATCHDOG_EXTRA_MS = 1500;      // buffer playback ends at the latest duration + 1.5 s (bug 28)
const AUTO_UNLOCK_MS = 300;
const GESTURE_UNLOCK_MS = 500;
const SYS_START_GUARD_MS = 1000;     // some iOS versions never fire utterance.onstart
const SPEED_RANGE = [-30, 50];       // store LIMITS.voiceSpeed
const DEFAULT_REGION = "germanywestcentral";
// CR1.2: prefer a male German voice (Butler flavour), then the iOS names of §3.5.2.
const VOICE_NAMES = ["markus", "yannick", "martin", "viktor", "hans", "florian", "conrad", "daniel", "männlich",
  "helmut", "reed", "eddy", "rocko"];
const CHIMES = { wake: [660, 990], done: [880, 620], error: [300, 220], timer: [880, 1175, 880, 1175] };

let deps = { settings: () => ({}) };
let inited = false;
const listeners = new Map();

let ctx = null;
let analyser = null;
let bins = null;

let gen = 0;                 // generation: stop() bumps it, stale playback/synthesis drops itself
let pumpGen = -1;            // generation of the running pump loop
let queue = [];              // items waiting to play
let pending = [];            // items kept while audio is locked/interrupted; replayed after a tap
let current = null;          // { item, kind: "buffer"|"system", stop() }
let burst = false;           // between the first say() of a burst and "end"
let started = false;         // "start" emitted in this burst
let waiters = [];
let muted = false;
let blockedEmitted = false;

let azureBroken = false;     // 401/403 until resetAzure()
let degradedUntil = 0;
let degradedWarned = false;
let lastLabel = "";

let sysVoice = null;
let lastCancelAt = 0;
const keep = new Set();      // strong references: Safari drops utterances (and their onend) otherwise

// ---------------------------------------------------------------------------------------------- helpers
function emit(event, ...args) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(...args); } catch { /* a listener must never break playback */ }
  }
}

function S() {
  try { return (deps.settings && deps.settings()) || {}; } catch { return {}; }
}

function hasWindow() { return typeof window !== "undefined"; }

function synthApi() {
  if (!hasWindow()) return null;
  return window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function" ? window.speechSynthesis : null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function cleanRegion(r) {
  const s = String(r || "").trim();
  return /^[a-z0-9]{2,40}$/i.test(s) ? s : DEFAULT_REGION;
}

function setSession(type) {
  try { if (typeof navigator !== "undefined" && navigator.audioSession) navigator.audioSession.type = type; } catch { /* Safari < 17 */ }
}

/** Voice config from the saved settings, optionally overlaid with unsaved draft values (voice test). */
function voiceCfg(draft = null) {
  const s = { ...S() };
  if (draft) {
    for (const k of ["voicePreset", "voiceSpeed", "azureKey", "azureRegion"]) {
      if (draft[k] !== undefined && draft[k] !== null) s[k] = draft[k];
    }
  }
  const preset = PRESETS[s.voicePreset] || PRESETS.geraet;
  let speed = Number(s.voiceSpeed);
  if (!Number.isFinite(speed)) speed = 0;
  speed = clamp(Math.round(speed), SPEED_RANGE[0], SPEED_RANGE[1]);
  return {
    preset, voice: preset.voice, rate: preset.rate + speed, pitch: preset.pitch, speed,
    key: String(s.azureKey || "").trim(), region: cleanRegion(s.azureRegion),
    sysRate: clamp(preset.sys.rate * (1 + speed / 100), 0.5, 2), sysPitch: preset.sys.pitch,
    draft: !!draft,
  };
}

function azureOk(cfg) {
  if (!cfg.key || cfg.preset.free) return false;
  if (cfg.draft) return true;
  return !azureBroken && Date.now() >= degradedUntil;
}

function emitEngine() {
  const label = engineLabel();
  if (label === lastLabel) return;
  lastLabel = label;
  emit("engine", label);
}

function baseName(name) { return String(name || "").replace(/\s*\(.*$/, "").trim(); }

function pickVoice() {
  let all = [];
  try { const sy = synthApi(); all = (sy && sy.getVoices && sy.getVoices()) || []; } catch { all = []; }
  const deDE = all.filter((v) => /^de[-_]de$/i.test(String(v.lang || "")));
  const de = deDE.length ? deDE : all.filter((v) => /^de([-_]|$)/i.test(String(v.lang || "")));
  const better = (v) => /premium|erweitert|enhanced/i.test(`${v.name || ""} ${v.voiceURI || ""}`);
  const rank = (v) => (better(v) ? 2 : 0) + (v.localService ? 1 : 0);
  const best = (list) => list.slice().sort((a, b) => rank(b) - rank(a))[0];
  for (const n of VOICE_NAMES) {
    const re = new RegExp(`(^|[^\\p{L}])${n}([^\\p{L}]|$)`, "iu");
    const hits = de.filter((v) => re.test(String(v.name || "")));
    if (hits.length) return best(hits);
  }
  return de.length ? best(de) : null;
}

function onVoices() {
  sysVoice = pickVoice();
  emitEngine();
}

// ---------------------------------------------------------------------------------------------- audio context
function ensureCtx() {
  if (ctx) return ctx;
  if (!hasWindow()) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    analyser.connect(ctx.destination);
    bins = new Uint8Array(analyser.frequencyBinCount);
    try { if (typeof ctx.addEventListener === "function") ctx.addEventListener("statechange", onCtxState); } catch { /* ignore */ }
    if (ctx.onstatechange == null) ctx.onstatechange = onCtxState;
  } catch {
    ctx = null;
    analyser = null;
    bins = null;
  }
  return ctx;
}

function hasAudioApi() { return hasWindow() && !!(window.AudioContext || window.webkitAudioContext); }

function isRunning() {
  if (!ctx) return !hasAudioApi();
  return ctx.state === "running";
}

async function resumeQuick(ms) {
  const c = ensureCtx();
  if (!c) return true;
  if (c.state === "running") return true;
  try {
    const p = c.resume();
    await Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);
  } catch { /* ignore */ }
  return c.state === "running";
}

// iOS: a phone call, Siri or an app switch interrupts/suspends the context while Jarvis speaks.
function onCtxState() {
  if (!ctx) return;
  const st = ctx.state;
  if (st !== "interrupted" && st !== "suspended") return;
  if (!burst || (!current && !queue.length)) return;
  const kept = [];
  if (current && current.item) kept.push(current.item);     // not heard completely: replay it after the tap
  kept.push(...queue);
  const c = current;
  gen++;                                                     // the running pump loop drops out
  queue = [];
  current = null;
  try { if (c) c.stop(); } catch { /* ignore */ }
  pending = pending.concat(kept);
  emitBlocked();
  finishBurst();
}

function emitBlocked() {
  if (blockedEmitted) return;
  blockedEmitted = true;
  emit("blocked");
}

function afterUnlock() {
  blockedEmitted = false;
  if (!pending.length) return;
  const items = pending;
  pending = [];
  queue.push(...items);
  beginBurst();
  kick();
}

function primeSynth() {
  const sy = synthApi();
  if (!sy || (current && current.kind === "system")) return;
  try {
    const u = new window.SpeechSynthesisUtterance(" ");
    u.volume = 0;
    u.lang = "de-DE";
    keep.add(u);
    const drop = () => keep.delete(u);
    u.onend = drop;
    u.onerror = drop;
    setTimeout(drop, 3000);
    sy.speak(u);
  } catch { /* ignore */ }
}

function onAnyTap() {
  // Passive help: any later tap resumes a suspended context (e.g. after a call); queued speech then plays.
  if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
  try {
    Promise.resolve(ctx.resume()).then(() => { if (ctx && ctx.state === "running") afterUnlock(); }, () => {});
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------- public API
export function warmPhrases(anrede, closing) {
  const A = String(anrede || "").trim() || "Boss";
  const list = [
    "Ja, {A}?", "Bis später, {A}.", "Gute Nacht, {A}.", "Bis morgen, {A}.", "Jederzeit, {A}.",
    "Das hat leider nicht geklappt.", "Hier bin ich, {A}.", "Alles klar, neues Gespräch.", "Okay, {A}.",
    "Dazu sage ich lieber nichts, {A}.",
  ].map((s) => s.split("{A}").join(A));
  const c = String(closing || "").trim();
  if (c) list.push(c);
  return [...new Set(list)];
}

export function init(d = {}) {
  deps = { settings: () => ({}), ...(d || {}) };
  if (inited) { emitEngine(); return; }
  inited = true;
  sysVoice = pickVoice();
  const sy = synthApi();
  if (sy) {
    try { if (typeof sy.addEventListener === "function") sy.addEventListener("voiceschanged", onVoices); } catch { /* ignore */ }
    try { if (sy.onvoiceschanged == null) sy.onvoiceschanged = onVoices; } catch { /* ignore */ }
  }
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("touchend", onAnyTap, { capture: true, passive: true });
    document.addEventListener("click", onAnyTap, { capture: true, passive: true });
  }
  lastLabel = engineLabel();
}

export function on(event, fn) {
  if (typeof fn !== "function") return () => {};
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => { const set = listeners.get(event); if (set) set.delete(fn); };
}

export function audioContext() { return ctx; }

export function isUnlocked() { return isRunning(); }

export async function tryAutoUnlock() {
  const ok = await resumeQuick(AUTO_UNLOCK_MS);
  if (ok) blockedEmitted = false;
  return ok;
}

/** Must run synchronously inside a tap (iOS): resume the context, a silent buffer, a silent utterance. */
export function unlockInGesture() {
  const c = ensureCtx();
  let rp = null;
  if (c) {
    try { rp = c.resume(); if (rp && rp.catch) rp.catch(() => {}); } catch { rp = null; }
    try {
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, 22050);
      src.connect(c.destination);
      src.start(0);
    } catch { /* ignore */ }
  }
  primeSynth();
  return new Promise((resolve) => {
    if (!c) { resolve(true); return; }
    let over = false;
    let poll = null;
    let to = null;
    const fin = () => {
      if (over) return;
      over = true;
      clearInterval(poll);
      clearTimeout(to);
      resolve(c.state === "running");
    };
    if (c.state === "running") { fin(); return; }
    poll = setInterval(() => { if (c.state === "running") fin(); }, 25);
    to = setTimeout(fin, GESTURE_UNLOCK_MS);
    if (rp && rp.then) rp.then(() => { if (c.state === "running") fin(); }, () => {});
  }).then((ok) => {
    if (ok) afterUnlock();
    return ok;
  });
}

/** Enqueue a sentence (cleaned); Azure synthesis starts right away. Dropped while muted. */
export function say(text) {
  if (muted) return;
  const t = clean(String(text == null ? "" : text));
  if (!t) return;
  enqueue(makeItem(t, voiceCfg(), false));
}

export function done() {
  if (!burst && !queue.length) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}

export function stop() {
  gen++;
  for (const it of queue) abortItem(it);
  for (const it of pending) abortItem(it);
  queue = [];
  pending = [];
  const c = current;
  current = null;
  try { if (c) c.stop(); } catch { /* ignore */ }
  cancelSynth(!!c && c.kind === "system");
  if (burst) finishBurst();
  else flushWaiters();
}

export function isSpeaking() { return burst; }

export function setMuted(on) {
  muted = !!on;
  if (muted) stop();
}

export function isMuted() { return muted; }

export function usesAzure() { return azureOk(voiceCfg()); }

export function engineLabel() {
  const cfg = voiceCfg();
  if (azureOk(cfg)) return `${cfg.preset.name.toUpperCase()} · AZURE`;
  const v = sysVoice || pickVoice();
  const n = v ? baseName(v.name) : "";
  return n ? `GERÄTESTIMME · ${n.toUpperCase()}` : "GERÄTESTIMME";
}

export function resetAzure() {
  azureBroken = false;
  degradedUntil = 0;
  degradedWarned = false;
  emitEngine();
}

/** Short tones like the Mac (mac app.js chime): 90 ms apart, ramp to .07, 160 ms decay. No-op while locked. */
export function chime(kind) {
  const c = ctx;
  if (!c || c.state !== "running") return;
  const tones = CHIMES[kind] || [700];
  tones.forEach((f, i) => {
    try {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const t = c.currentTime + i * 0.09;
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.07, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    } catch { /* ignore */ }
  });
}

/** Settings sheet „Stimme testen“: speaks once with the unsaved draft, saves nothing (bug 11). */
export function test(text, draft = {}) {
  stop();
  const t = clean(String(text == null ? "" : text));
  if (!t) return Promise.resolve();
  enqueue(makeItem(t, voiceCfg(draft || {}), true));
  return done();
}

/** Fill the TTS cache with short phrases (Azure only). Returns how many are cached now. */
export async function prewarm(phrases) {
  const cfg = voiceCfg();
  if (!azureOk(cfg)) return 0;
  let n = 0;
  for (const raw of phrases || []) {
    const t = clean(String(raw == null ? "" : raw));
    if (!t || t.length > CACHE_MAX_CHARS) continue;
    try {
      const bytes = await ttsBytes(t, cfg, null);
      if (bytes) n++;
    } catch { /* ignore */ }
    if (!azureOk(cfg)) break;
  }
  return n;
}

// ---------- Text sprechbar machen (Port von speak.py clean am Mac) + AKTION-Zeilen weg ----------
export function clean(text) {
  let t = String(text == null ? "" : text).replace(/```[\s\S]*?```/g, " ");
  t = t.split(/\r?\n/).map((line) => {
    let s = line.trim();
    if (/^AKTION:/i.test(s)) return "";
    s = s.replace(/\s*AKTION:\s*\{.*$/, "");                        // mid-line action payload is never read aloud
    if (s.startsWith("|") && /^[\s|:-]+$/.test(s)) return "";
    if (s.startsWith("|")) s = s.replace(/^\|+|\|+$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ");
    return s.replace(/^#{1,6}\s*/, "").replace(/^([-*+]|\d+\.)\s+/, "").replace(/^>\s?/, "");
  }).join("\n");
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "Link")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|~~|\*/g, "")
    .replace(/[ \t]+/g, " ");
  return t.replace(/\n{2,}/g, "\n").trim();
}

// ---------------------------------------------------------------------------------------------- queue
function makeItem(text, cfg, force) {
  const item = { text, cfg, force, ctl: null, synth: null };
  // Azure: cache first, network only while Azure is healthy (synthesis starts now, bug 31: abortable).
  if (cfg.key && !cfg.preset.free && (cfg.draft || !azureBroken)) {
    item.ctl = typeof AbortController === "function" ? new AbortController() : null;
    item.synth = synthesize(text, cfg, item.ctl ? item.ctl.signal : null).catch(() => null);
  }
  return item;
}

function abortItem(item) {
  try { if (item && item.ctl) item.ctl.abort(); } catch { /* ignore */ }
}

function enqueue(item) {
  if (blockedEmitted && !isRunning()) { pending.push(item); return; }   // locked: queued until the tap
  queue.push(item);
  beginBurst();
  kick();
}

function beginBurst() {
  if (burst) return;
  burst = true;
  started = false;
  setSession("playback");
  emitEngine();
}

function markStarted() {
  if (!burst || started) return;
  started = true;
  emit("start");
}

function flushWaiters() {
  const w = waiters;
  waiters = [];
  for (const fn of w) { try { fn(); } catch { /* ignore */ } }
}

function finishBurst() {
  const was = burst;
  burst = false;
  started = false;
  current = null;
  setSession("auto");
  emit("level", 0, [0, 0, 0]);
  if (was) emit("end");
  flushWaiters();
}

function kick() {
  if (pumpGen === gen) return;
  pump();
}

async function pump() {
  const my = gen;
  pumpGen = my;
  try {
    while (my === gen && queue.length) {
      if (!isRunning()) {
        const ok = await resumeQuick(AUTO_UNLOCK_MS);
        if (my !== gen) break;
        if (!ok) {                                      // locked: keep everything for the tap, never hang
          pending = pending.concat(queue);
          queue = [];
          emitBlocked();
          break;
        }
        blockedEmitted = false;
      }
      const item = queue[0];
      let buf = null;
      if (item.synth) {
        try { buf = await item.synth; } catch { buf = null; }
      }
      if (my !== gen) break;
      queue.shift();
      if (muted && !item.force) continue;              // muted after synthesis: discard (Mac say L4313-4351)
      emit("chunk", item.text);
      if (buf && ctx && analyser) await playBuffer(buf, my, item);
      else await speakSystem(item, my);
    }
  } catch {
    /* never leave the burst open */
  } finally {
    if (pumpGen === my) pumpGen = -1;
  }
  if (my === gen) finishBurst();
}

function cancelSynth(force) {
  const sy = synthApi();
  if (!sy) return;
  let busy = force;
  try { busy = busy || sy.speaking || sy.pending; } catch { /* ignore */ }
  if (!busy) return;
  try { sy.cancel(); } catch { /* ignore */ }
  lastCancelAt = Date.now();
}

// ---------------------------------------------------------------------------------------------- playback
function playBuffer(buf, my, item) {
  return new Promise((resolve) => {
    let src;
    try {
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(analyser);
    } catch {
      resolve("error");
      return;
    }
    let over = false;
    let wd = null;
    const fin = (why) => {
      if (over) return;
      over = true;
      clearTimeout(wd);
      src.onended = null;
      try { src.stop(); } catch { /* already ended */ }
      try { src.disconnect(); } catch { /* ignore */ }
      if (current && current.src === src) current = null;
      emit("level", 0, [0, 0, 0]);
      resolve(why);
    };
    // Watchdog: if the context is suspended/interrupted onended never fires (bug 28).
    wd = setTimeout(() => fin("watchdog"), Math.max(0, (buf.duration || 0) * 1000) + WATCHDOG_EXTRA_MS);
    current = { item, kind: "buffer", src, stop: () => fin("stopped") };
    src.onended = () => fin("ended");
    try { src.start(); } catch { fin("error"); return; }
    markStarted();
    meter(my, src);
  });
}

// Mac speechLevels (mac app.js L157-170): three bands drive the orb, once per animation frame.
function meter(my, src) {
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f) => setTimeout(f, 33);
  const step = () => {
    if (my !== gen || !current || current.src !== src || !analyser || !bins) return;
    try {
      analyser.getByteFrequencyData(bins);
      const band = (a, b) => {
        let s = 0;
        for (let i = a; i < b; i++) s += bins[i];
        return Math.min(1, s / ((b - a) * 170));
      };
      const low = band(1, 6);
      const mid = band(6, 24);
      const high = band(24, 64);
      emit("level", Math.min(1, (low + mid + high) / 2.2), [low, mid, high]);
    } catch { return; }
    raf(step);
  };
  raf(step);
}

// iOS voice fallback (and the voice without Azure key).
function speakSystem(item, my) {
  return new Promise((resolve) => {
    const sy = synthApi();
    if (!sy) { resolve("none"); return; }
    const go = () => {
      if (my !== gen) { resolve("stale"); return; }
      const cfg = item.cfg;
      let u;
      try { u = new window.SpeechSynthesisUtterance(item.text); } catch { resolve("error"); return; }
      u.lang = "de-DE";
      const v = sysVoice || pickVoice();
      if (v) { try { u.voice = v; } catch { /* ignore */ } }
      u.rate = cfg.sysRate;
      u.pitch = cfg.sysPitch;
      let over = false;
      let began = false;
      let boost = 0.5;
      let guard = null;
      let startGuard = null;
      let sim = null;
      const fin = (why) => {
        if (over) return;
        over = true;
        clearTimeout(guard);
        clearTimeout(startGuard);
        clearInterval(sim);
        u.onstart = u.onend = u.onerror = u.onboundary = null;
        keep.delete(u);
        if (current && current.u === u) current = null;
        emit("level", 0, [0, 0, 0]);
        resolve(why);
      };
      const begin = () => {
        if (began || over) return;
        began = true;
        markStarted();
      };
      // Safari sometimes never reports the end: continue after the estimated speaking time at the latest.
      guard = setTimeout(() => { cancelSynth(true); fin("guard"); }, 2500 + item.text.length * 95 / u.rate);
      startGuard = setTimeout(begin, SYS_START_GUARD_MS);
      // No audio data: the orb pulses in a speaking rhythm.
      sim = setInterval(() => {
        if (over || !began || my !== gen) return;
        boost *= 0.86;
        const l = Math.min(1, 0.18 + boost + Math.random() * 0.15);
        emit("level", l, [l, l * 0.7, l * 0.4]);
      }, 70);
      u.onstart = begin;
      u.onboundary = () => { boost = 0.55 + Math.random() * 0.4; };
      u.onend = () => fin("ended");
      u.onerror = () => fin("error");
      keep.add(u);
      current = { item, kind: "system", u, stop: () => { cancelSynth(true); fin("stopped"); } };
      try { sy.speak(u); } catch { fin("error"); }
    };
    const wait = lastCancelAt + CANCEL_GAP_MS - Date.now();
    if (wait > 0) setTimeout(go, wait);
    else go();
  });
}

// ---------------------------------------------------------------------------------------------- Azure TTS
const esc = (s) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
const signed = (n, unit) => (n >= 0 ? "+" : "") + n + unit;

function ssml(text, cfg) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="de-DE">`
    + `<voice name="${cfg.voice}"><prosody rate="${signed(cfg.rate, "%")}" pitch="${signed(cfg.pitch, "Hz")}">${esc(text)}</prosody></voice></speak>`;
}

async function sha1hex(text) {
  const subtle = typeof crypto !== "undefined" && crypto.subtle;
  if (!subtle || typeof TextEncoder !== "function") return null;
  const digest = await subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function cacheKey(cfg, text) {
  const hex = await sha1hex(text);
  return hex ? `https://tts.cache/${encodeURIComponent(cfg.voice)}/${cfg.rate}/${cfg.pitch}/${hex}.mp3` : null;
}

async function openCache() {
  if (typeof caches === "undefined" || !caches.open) return null;
  return caches.open(CACHE_NAME);
}

function breakAzure(cfg) {
  if (!cfg.draft) {
    if (azureBroken) return;
    azureBroken = true;
  }
  emit("warn", WARN_KEY);
  emitEngine();
}

function degrade(cfg) {
  if (cfg.draft) { emit("warn", WARN_DOWN); return; }
  degradedUntil = Date.now() + DEGRADE_MS;
  if (!degradedWarned) {
    degradedWarned = true;
    emit("warn", WARN_DOWN);
  }
  emitEngine();
}

function healthy(cfg) {
  if (cfg.draft) return;
  degradedUntil = 0;
  degradedWarned = false;
}

function isAbort(e) { return !!e && (e.name === "AbortError" || e.code === 20); }

/** MP3 bytes for a text: Cache Storage first (≤ 80 chars), then the Azure REST endpoint. */
async function ttsBytes(text, cfg, signal) {
  let cache = null;
  let key = null;
  if (text.length <= CACHE_MAX_CHARS) {
    try {
      key = await cacheKey(cfg, text);
      cache = key ? await openCache() : null;
      if (cache) {
        const hit = await cache.match(key);
        if (hit) return await hit.arrayBuffer();
      }
    } catch { cache = null; key = null; }
  }
  if ((signal && signal.aborted) || !azureOk(cfg)) return null;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const onAbort = () => { try { if (ctl) ctl.abort(); } catch { /* ignore */ } };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; onAbort(); }, TTS_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(`https://${cfg.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": cfg.key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        },
        body: ssml(text, cfg),
        signal: ctl ? ctl.signal : undefined,
      });
    } catch (e) {
      if (timedOut || !(isAbort(e) || (signal && signal.aborted))) degrade(cfg);   // network / CORS TypeError
      return null;
    }
    if (res.status === 401 || res.status === 403) { breakAzure(cfg); return null; }
    if (res.status === 429 || res.status >= 500) { degrade(cfg); return null; }
    if (!res.ok) return null;
    let bytes;
    try { bytes = await res.arrayBuffer(); } catch (e) {
      if (timedOut || !(isAbort(e) || (signal && signal.aborted))) degrade(cfg);
      return null;
    }
    if (!bytes || !bytes.byteLength) return null;
    healthy(cfg);
    if (cache && key) {
      try { await cache.put(key, new Response(bytes.slice(0), { headers: { "Content-Type": "audio/mpeg" } })); } catch { /* quota */ }
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function decode(c, bytes) {
  return new Promise((resolve, reject) => {
    try {
      const p = c.decodeAudioData(bytes, resolve, reject);
      if (p && typeof p.then === "function") p.then(resolve, reject);
    } catch (e) { reject(e); }
  });
}

async function synthesize(text, cfg, signal) {
  const bytes = await ttsBytes(text, cfg, signal);
  if (!bytes || (signal && signal.aborted)) return null;
  const c = ensureCtx();
  if (!c) return null;
  try { return await decode(c, bytes.slice(0)); } catch { return null; }
}
