// ==============================================================================================================
// CONTRACT – awake.js (owner: builder CORE). Spec: ARCHITECTURE.md §3.2.9, §3.5.4, §9.9 (bug 12).
// export async function keepAwake(on): Promise<"wakelock"|"video"|"none"|"off">   idempotent, remembers the wish
// export function method(): "wakelock"|"video"|"none"|"off"
// Imports nothing; uses only #awake-video (muted, inline, looping "media/awake.mp4").
// ==============================================================================================================
// Bildschirm wach halten, solange Jarvis auf „Jarvis“ lauscht: Sperrt sich das Gerät, hört keine Web-App mehr zu.
// Erste Wahl ist die Screen Wake Lock API. Gibt das System die Sperre frei (Energiesparen, App-Wechsel), holt
// awake.js sie zurück, sobald die Seite wieder sichtbar ist. Ohne Wake Lock läuft ein stummes, schwarzes
// 2-Sekunden-Video in Schleife (hält iOS und ältere Browser wach); lehnt der Browser das Abspielen ohne Berührung
// ab, startet es bei der nächsten Berührung.

let want = false;
let current = "off";
let sentinel = null;
let requesting = null;
let listening = false;
let tapArmed = false;
let gen = 0;

const VIDEO_SRC = "media/awake.mp4";

function hasWakeLock() {
  try { return typeof navigator !== "undefined" && !!navigator.wakeLock && typeof navigator.wakeLock.request === "function"; }
  catch { return false; }
}

function visible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function video() {
  if (typeof document === "undefined") return null;
  const v = document.getElementById("awake-video");
  if (!v) return null;
  try {
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute("muted", "");
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
    if (!v.getAttribute("src")) v.setAttribute("src", VIDEO_SRC);
  } catch { /* ignore */ }
  return v;
}

function stopVideo() {
  const v = typeof document !== "undefined" ? document.getElementById("awake-video") : null;
  if (!v) return;
  try { v.pause(); } catch { /* ignore */ }
}

function disarmTap() {
  if (!tapArmed) return;
  tapArmed = false;
  try {
    document.removeEventListener("pointerdown", onTap, true);
    document.removeEventListener("touchend", onTap, true);
  } catch { /* ignore */ }
}

function armTap() {
  if (tapArmed || typeof document === "undefined") return;
  tapArmed = true;
  document.addEventListener("pointerdown", onTap, true);
  document.addEventListener("touchend", onTap, true);
}

// Berührung: Video direkt in der Geste starten (iOS erlaubt play() nur dann), Wake Lock nebenbei neu versuchen.
function onTap() {
  disarmTap();
  if (!want) return;
  if (current === "wakelock" && sentinel && !sentinel.released) return;
  const v = video();
  if (v) {
    try {
      const p = v.play();
      if (p && typeof p.then === "function") {
        p.then(() => { if (want && current !== "wakelock") current = "video"; else if (!want) stopVideo(); },
          () => { if (want && current !== "wakelock") { current = "none"; armTap(); } });
      } else if (want) current = "video";
    } catch { armTap(); }
  }
  if (hasWakeLock()) acquire();
}

function onRelease() {
  sentinel = null;
  if (current === "wakelock") current = want ? "none" : "off";
  if (want && visible()) acquire();         // vom System freigegeben, Seite noch sichtbar: zurückholen (bug 12)
}

function onVisibility() {
  if (!want) return;
  if (visible()) acquire();
}

function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("visibilitychange", onVisibility);
  if (typeof window !== "undefined") window.addEventListener("pageshow", onVisibility);
}

async function startVideo(my) {
  const v = video();
  if (!v) {
    current = "none";
    return current;
  }
  try {
    await v.play();
    if (my !== gen || !want) {
      if (!want) stopVideo();
      return current;
    }
    current = "video";
  } catch {
    if (my !== gen) return current;
    current = "none";
    armTap();                                   // ohne Berührung verweigert: bei der nächsten Berührung nochmal
  }
  return current;
}

async function acquire() {
  if (!want) return "off";
  if (!visible()) return current;               // ausgeblendet gibt es keine Sperre; bei „sichtbar“ neu
  if (sentinel && !sentinel.released) {
    current = "wakelock";
    return current;
  }
  if (requesting) return requesting;
  const my = ++gen;
  requesting = (async () => {
    if (hasWakeLock()) {
      try {
        const s = await navigator.wakeLock.request("screen");
        if (!want || my !== gen) {
          try { await s.release(); } catch { /* ignore */ }
          return current;
        }
        sentinel = s;
        try { s.addEventListener("release", onRelease, { once: true }); } catch { s.onrelease = onRelease; }
        current = "wakelock";
        disarmTap();
        stopVideo();
        return current;
      } catch {
        // abgelehnt (z. B. Energiesparmodus oder ohne Berührung): Video als Ersatz
      }
    }
    return startVideo(my);
  })();
  try {
    return await requesting;
  } finally {
    requesting = null;
  }
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
 * Bildschirm wach halten an/aus. Idempotent; der Wunsch bleibt gespeichert und wird nach dem Zurückkehren
 * auf die Seite oder einer Freigabe durch das System erneuert.
 * @param {boolean} on
 * @returns {Promise<"wakelock"|"video"|"none"|"off">}
 */
export async function keepAwake(on) {
  listen();
  want = !!on;
  if (!want) {
    await release();
    current = "off";
    return current;
  }
  try {
    return await acquire();
  } catch {
    current = "none";
    return current;
  }
}

/** @returns {"wakelock"|"video"|"none"|"off"} */
export function method() {
  return current;
}
