// ==============================================================================================================
// CONTRACT – awake.js (owner: builder CORE). Spec: ARCHITECTURE.md §3.2.9, §3.5.4, §9.9 (bug 12).
// export async function keepAwake(on): Promise<"wakelock"|"video"|"none"|"off">   idempotent, remembers the wish
// export function method(): "wakelock"|"video"|"none"|"off"
// export function inGesture(intent?)   call synchronously inside a real tap/click/key: lock (+ video) with activation
// export function needsGesture(): boolean   wanted, but the screen is not kept on yet (only a tap can fix that)
// Imports nothing; uses only #awake-video ("media/awake.mp4": 4 s black clip WITH a silent AAC track).
// ==============================================================================================================
// Bildschirm wach halten, solange Jarvis auf „Jarvis“ lauscht: Sperrt sich das Gerät, hört keine Web-App mehr zu.
// Erste Wahl ist die Screen Wake Lock API. Safari erteilt sie nur innerhalb einer Berührung (danach auch ohne);
// darum versucht awake.js es bei jeder Berührung neu, bis eine Sperre wirklich gilt. Gibt das System die Sperre frei
// (Energiesparen, App-Wechsel), holt awake.js sie zurück, sobald die Seite wieder sichtbar ist.
// Ohne Wake Lock (ältere Browser, Home-Bildschirm-App vor iOS 18.4, abgelehnt) läuft ein schwarzes Video mit stummer
// Tonspur – nicht stummgeschaltet und ohne loop, sonst lässt iOS das Gerät trotzdem schlafen (NoSleep-Verfahren);
// es springt kurz vor dem Ende zurück. Starten darf es nur eine Berührung.

let want = false;
let current = "off";
let sentinel = null;
let pending = null;          // laufende Wake-Lock-Anfrage
let gesturePending = false;  // davon eine aus einer Berührung (nicht doppelt anfragen)
let listening = false;
let tapArmed = false;
let gen = 0;                 // release() erhöht: späte Antworten geben ihre Sperre gleich wieder ab
let lockFailed = false;      // in einer Berührung abgelehnt (z. B. Stromsparmodus): Video als Ersatz
let videoWanted = false;
let videoReady = false;

const VIDEO_SRC = "media/awake.mp4";
const REWIND_BEFORE_END = 1;   // s
const REWIND_TO = 0.25;        // s

function hasWakeLock() {
  try { return typeof navigator !== "undefined" && !!navigator.wakeLock && typeof navigator.wakeLock.request === "function"; }
  catch { return false; }
}

function visible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function isIOS() {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent || "")
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function standalone() {
  try { if (navigator.standalone === true) return true; } catch { /* ignore */ }
  try { return !!window.matchMedia?.("(display-mode: standalone)").matches; } catch { return false; }
}

function iosVersion() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const m = /\bOS (\d+)[_.](\d+)/.exec(ua) || /Version\/(\d+)\.(\d+)/.exec(ua);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// iOS 16.4 – 18.3 als Home-Bildschirm-App: request() gelingt, hält den Bildschirm aber nicht an (WebKit-Bug 254545).
function lockUseless() {
  if (!isIOS() || !standalone()) return false;
  const v = iosVersion();
  if (!v) return true;
  return v[0] < 18 || (v[0] === 18 && v[1] < 4);
}

function lockHeld() {
  return !!sentinel && !sentinel.released;
}

function lockWorks() {
  return lockHeld() && !lockUseless();
}

// Video nur, wo die Sperre nicht reicht: es übernimmt die Tonausgabe (andere Musik würde kurz unterbrochen).
function videoNeeded() {
  return want && !lockWorks() && (!hasWakeLock() || lockUseless() || lockFailed);
}

function video() {
  if (typeof document === "undefined") return null;
  const v = document.getElementById("awake-video");
  if (!v) return null;
  if (!videoReady) {
    videoReady = true;
    try {
      v.loop = false;
      v.removeAttribute("loop");
      v.muted = false;
      v.defaultMuted = false;
      v.removeAttribute("muted");
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      v.setAttribute("webkit-playsinline", "");
      try { v.volume = 1; } catch { /* iOS: nur lesbar */ }
      if (!v.getAttribute("src")) v.setAttribute("src", VIDEO_SRC);
      v.addEventListener("timeupdate", () => {
        const d = v.duration;
        if (videoWanted && Number.isFinite(d) && d > 0 && v.currentTime > d - REWIND_BEFORE_END) v.currentTime = REWIND_TO;
      });
      v.addEventListener("ended", () => {
        if (!videoWanted) return;
        try { v.currentTime = REWIND_TO; } catch { /* ignore */ }
        playVideo();
      });
      v.addEventListener("pause", () => {
        // vom System angehalten (Anruf, Siri): weiterspielen, sobald es geht – sonst bei der nächsten Berührung
        if (videoWanted && want && visible()) setTimeout(() => { if (videoWanted && v.paused) playVideo(); }, 400);
      });
    } catch { /* ignore */ }
  }
  return v;
}

function videoPlaying() {
  const v = typeof document !== "undefined" ? document.getElementById("awake-video") : null;
  return !!v && videoWanted && !v.paused && !v.ended;
}

function playVideo() {
  const v = video();
  if (!v) return Promise.resolve(false);
  videoWanted = true;
  if (!v.paused && !v.ended) return Promise.resolve(true);
  let p;
  try { p = v.play(); } catch (e) { p = Promise.reject(e); }
  return Promise.resolve(p).then(() => {
    if (!want || !videoNeeded()) { stopVideo(); return false; }
    current = computeCurrent();
    updateArm();
    return true;
  }, () => {
    if (want) armTap();                         // ohne Berührung verweigert: bei der nächsten Berührung nochmal
    return false;
  });
}

function stopVideo() {
  videoWanted = false;
  const v = typeof document !== "undefined" ? document.getElementById("awake-video") : null;
  if (!v) return;
  try { if (!v.paused) v.pause(); } catch { /* ignore */ }
}

function computeCurrent() {
  if (!want) return "off";
  if (lockWorks()) return "wakelock";
  if (videoPlaying()) return "video";
  if (lockHeld()) return "wakelock";
  return "none";
}

function disarmTap() {
  if (!tapArmed) return;
  tapArmed = false;
  try {
    for (const t of ["touchend", "click", "keydown"]) document.removeEventListener(t, onTap, true);
  } catch { /* ignore */ }
}

function armTap() {
  if (tapArmed || typeof document === "undefined") return;
  tapArmed = true;
  for (const t of ["touchend", "click", "keydown"]) document.addEventListener(t, onTap, true);
}

// Berührung so lange abfangen, bis eine Sperre wirklich gilt (Safari: nur mit Berührung, iOS < 18.4 als App: nie).
function updateArm() {
  if (want && !lockWorks()) armTap();
  else disarmTap();
}

function onTap(e) {
  if (e && e.isTrusted === false) return;
  if (e && e.type === "keydown" && (e.key === "Escape" || ["Shift", "Control", "Alt", "Meta"].includes(e.key))) return;
  inGesture();
}

/** Nimmt eine Sperre in Empfang (alle Wege) und hört auf ihre Freigabe. */
function adopt(s, my) {
  if (!want || my !== gen || lockHeld()) {
    try { s.release().catch(() => {}); } catch { /* ignore */ }
    return lockHeld();
  }
  sentinel = s;
  lockFailed = false;
  try { s.addEventListener("release", onRelease, { once: true }); } catch { s.onrelease = onRelease; }
  if (lockWorks()) stopVideo();
  current = computeCurrent();
  updateArm();
  return true;
}

function requestLock(fromGesture) {
  const my = gen;
  let p;
  if (fromGesture) gesturePending = true;
  try { p = navigator.wakeLock.request("screen"); } catch (e) { p = Promise.reject(e); }
  const q = Promise.resolve(p).then((s) => adopt(s, my), () => {
    if (fromGesture && my === gen) lockFailed = true;   // abgelehnt trotz Berührung: ab jetzt Video
    return false;
  }).finally(() => {
    if (fromGesture) gesturePending = false;
    if (pending === q) pending = null;
  });
  pending = q;
  return q;
}

function onRelease() {
  sentinel = null;
  current = computeCurrent();
  if (!want) return;
  updateArm();
  if (visible()) acquire().catch(() => {});      // vom System freigegeben, Seite noch sichtbar: zurückholen (bug 12)
}

function onVisibility() {
  if (!want) return;
  if (visible()) acquire().catch(() => {});
}

function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("visibilitychange", onVisibility);
  if (typeof window !== "undefined") window.addEventListener("pageshow", onVisibility);
}

async function acquire() {
  if (!want) return "off";
  if (!visible()) return current;               // ausgeblendet gibt es keine Sperre; bei „sichtbar“ neu
  if (hasWakeLock() && !lockHeld()) {
    if (pending) await pending;
    if (want && !lockHeld() && visible()) await requestLock(false);
  }
  if (!want) return "off";
  if (videoNeeded()) await playVideo();
  else if (lockWorks()) stopVideo();
  current = computeCurrent();
  updateArm();
  return current;
}

async function release() {
  gen++;
  disarmTap();
  const s = sentinel;
  sentinel = null;
  if (s) {
    try { s.removeEventListener("release", onRelease); } catch { /* ignore */ }
    try { await s.release(); } catch { /* ignore */ }
  }
  stopVideo();
}

/**
 * Synchron in einer echten Berührung aufrufen (Tippen, Klick, Taste): Wake Lock mit Nutzeraktivierung anfordern und,
 * wo nötig, das Video starten. intent = true: auch dann, wenn app.js die Sperre gleich erst haben will (Fänger).
 * @param {boolean} [intent]
 */
export function inGesture(intent = false) {
  if (!want && !intent) return;
  listen();
  if (intent && !want) want = true;            // der Wunsch kommt gleich von app.js; sonst gibt keepAwake(false) sie frei
  if (hasWakeLock() && !lockHeld() && !gesturePending) requestLock(true);
  if (videoNeeded() && !videoPlaying()) playVideo();
  current = computeCurrent();
  updateArm();
}

/** Wach halten gewünscht, aber (noch) keine wirksame Sperre und kein Video – das kann nur eine Berührung ändern. */
export function needsGesture() {
  return want && !lockWorks() && !videoPlaying();
}

/**
 * Bildschirm wach halten an/aus. Idempotent; der Wunsch bleibt gespeichert und wird nach dem Zurückkehren
 * auf die Seite oder einer Freigabe durch das System erneuert.
 * @param {boolean} on
 * @returns {Promise<"wakelock"|"video"|"none"|"off">}
 */
export async function keepAwake(on) {
  listen();
  const was = want;
  want = !!on;
  if (!want) {
    if (was || sentinel || videoWanted || tapArmed) await release();
    current = "off";
    return current;
  }
  try {
    return await acquire();
  } catch {
    current = computeCurrent();
    return current;
  }
}

/** @returns {"wakelock"|"video"|"none"|"off"} */
export function method() {
  return current;
}
