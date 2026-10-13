// ==============================================================================================================
// CONTRACT – sw.js (owner: builder CORE). Spec: ARCHITECTURE.md §3.5.4 (bugs 39, 40).
// VERSION "jarvis-v2-<yyyymmddhhmm>" (bump on every deploy); caches `shell-${VERSION}` and `static-${VERSION}`.
// Same-origin navigations and .html/.js/.mjs/.css/.json/.webmanifest: network-first, cache fallback (no mixed
// module versions). A navigation that gets no answer within NAV_TIMEOUT_MS is served from the cache and that page
// load then takes all its app files from the cache too (one version per load); the network answer still refreshes
// the cache in the background. icons/, media/, vendor/, fonts/: cache-first; Range requests for media/ (Safari's video
// loader) go to the network, offline a 206 is cut from the cached file. Everything else (Claude, Gemini, Azure,
// markets, weather, Wikipedia): network only, never cached.
// Only Jarvis' own files are handled (security-privacy-2): at the root of a GitHub-Pages address other pages of the
// same origin (project pages /<repo>/…) stay untouched – no caching, no offline index.html for them – and activate
// only deletes Jarvis' own old caches, never those of other apps on the same origin.
// ==============================================================================================================
// Offline-Start: Die App-Dateien kommen frisch aus dem Netz und landen dabei im Cache; ohne Netz – oder bei sehr
// langsamem Netz nach 3 s – startet Jarvis aus dem Cache. Anfragen an Claude, Gemini, Azure, Kurse, Wetter und
// Wikipedia gehen nie über den Cache.

const VERSION = "jarvis-v2-202610131723";
const SHELL_CACHE = `shell-${VERSION}`;
const STATIC_CACHE = `static-${VERSION}`;
const KEEP_PREFIXES = ["jarvis-tts"];          // Stimmen-Cache von voice.js bleibt über Updates erhalten

const SHELL = [
  "./", "index.html", "style.css", "galaxy.js", "neuro.js", "model3d.js", "app.js", "hud.js", "ears.js", "voice.js",
  "brain.js", "tools.js", "store.js", "intents.js", "sheets.js", "awake.js", "manifest.webmanifest",
];
const STATIC = [
  "vendor/anthropic.mjs", "media/awake.mp4",
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png",
  "fonts/orbitron-latin.woff2", "fonts/rajdhani-500-latin.woff2", "fonts/rajdhani-500-latin-ext.woff2",
  "fonts/rajdhani-600-latin.woff2", "fonts/rajdhani-600-latin-ext.woff2", "fonts/rajdhani-700-latin.woff2",
  "fonts/rajdhani-700-latin-ext.woff2",
];
const OWN_CACHE = /^(?:shell|static)-jarvis-/;  // nur eigene alte Caches löschen (andere Apps derselben Adresse nicht)
const SHELL_FILES = new Set(SHELL.filter((f) => f !== "./"));
const CACHE_FIRST = /^(?:icons|media|vendor|fonts)\/[^/]+$/;
const MEDIA = /^media\//;
// Pfad relativ zum Ort von sw.js („“ = die Startseite); null = gehört nicht zu Jarvis
const BASE_PATH = (() => {
  try { return new URL("./", self.location.href).pathname; } catch { return "/"; }
})();
function ownPath(pathname) {
  return pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) : null;
}
const NAV_TIMEOUT_MS = 3000;
const CACHE_LOAD_MS = 20000;
const cacheClients = new Set();                 // Seiten, die aus dem Cache gestartet sind
let cacheLoadUntil = 0;                         // dasselbe ohne clientId (ältere Safari-Versionen)

// Einzeln laden: eine fehlende Datei darf die Installation nicht kippen.
async function precache(name, list) {
  const cache = await caches.open(name);
  await Promise.all(list.map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => {})));
}

self.addEventListener("install", (e) => {
  e.waitUntil(Promise.all([precache(SHELL_CACHE, SHELL), precache(STATIC_CACHE, STATIC)]).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => OWN_CACHE.test(k) && k !== SHELL_CACHE && k !== STATIC_CACHE && !KEEP_PREFIXES.some((p) => k.startsWith(p)))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Schlüssel ohne ?…: „/?wake=1“ und „/“ sind dieselbe Seite, Pings landen nicht als neue Einträge im Cache.
function keyOf(url) {
  return url.origin + url.pathname;
}

async function cachedCopy(cache, req, key, isNav) {
  const hit = (await cache.match(key, { ignoreSearch: true })) || (await caches.match(req, { ignoreSearch: true }));
  if (hit) return hit;
  if (isNav) {
    const page = (await cache.match("index.html", { ignoreSearch: true })) || (await cache.match("./"));
    if (page) return page;
  }
  return null;
}

async function networkFirst(req, isNav, e) {
  const cache = await caches.open(SHELL_CACHE);
  const url = new URL(req.url);
  const key = keyOf(url);
  const fresh = isNav
    ? new Request(url.href, { cache: "no-cache", credentials: "same-origin" })
    : new Request(req, { cache: "no-cache" });
  const net = fetch(fresh).then((res) => {
    if (res && res.ok && res.type === "basic" && req.cache !== "no-store") {
      cache.put(key, res.clone()).catch(() => {});
    }
    return res;
  });
  if (!isNav) {
    try {
      return await net;
    } catch {
      return (await cachedCopy(cache, req, key, false)) || Response.error();
    }
  }
  // Seitenaufruf: höchstens NAV_TIMEOUT_MS aufs Netz warten (ein Balken, halbtotes WLAN), dann aus dem Cache
  let timer = 0;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), NAV_TIMEOUT_MS); });
  try {
    const first = await Promise.race([net, late]);
    if (first !== "timeout") {
      cacheLoadUntil = 0;
      return first;
    }
    const hit = await cachedCopy(cache, req, key, true);
    if (!hit) return await net;
    if (e && e.waitUntil) e.waitUntil(net.catch(() => null));    // aktualisiert den Cache fürs nächste Mal
    if (e && e.resultingClientId) cacheClients.add(e.resultingClientId);
    cacheLoadUntil = Date.now() + CACHE_LOAD_MS;
    return hit;
  } catch {
    return (await cachedCopy(cache, req, key, true)) || Response.error();
  } finally {
    clearTimeout(timer);
  }
}

// Diese Seite ist aus dem Cache gestartet: ihre Module auch (sonst mischen sich zwei Versionen, bug 39)
function fromCacheLoad(e) {
  if (e.clientId) return cacheClients.has(e.clientId);
  return Date.now() < cacheLoadUntil;
}

async function cacheThenNetwork(req, e) {
  const cache = await caches.open(SHELL_CACHE);
  const key = keyOf(new URL(req.url));
  const hit = await cachedCopy(cache, req, key, false);
  if (hit) return hit;
  return networkFirst(req, false, e);
}

// Safari lädt Videos stückweise (Range): Netz; offline das passende Stück aus der Datei im Cache
async function mediaRange(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(req.url, { ignoreSearch: true });
    if (!hit) throw err;
    const buf = await hit.arrayBuffer();
    const size = buf.byteLength;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    end = Math.min(end, size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    return new Response(buf.slice(start, end + 1), {
      status: 206,
      headers: { "Content-Type": hit.headers.get("Content-Type") || "video/mp4", "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes" },
    });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()).catch(() => {});
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                               // POST an Claude/Gemini/Azure: nur Netz
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;                // fremde Dienste: direkt ins Netz, nie in den Cache
  const rel = ownPath(url.pathname);
  if (rel === null) return;
  if (MEDIA.test(rel) && req.headers.has("range")) {
    e.respondWith(mediaRange(req));
    return;
  }
  if (CACHE_FIRST.test(rel)) {
    e.respondWith(cacheFirst(req));
    return;
  }
  const isNav = req.mode === "navigate";
  // nur die Startseite und Jarvis' eigene Dateien; andere Seiten derselben Adresse gehen ungefiltert ins Netz
  if (isNav ? rel === "" || rel === "index.html" : rel === "" || SHELL_FILES.has(rel)) {
    e.respondWith(!isNav && fromCacheLoad(e) ? cacheThenNetwork(req, e) : networkFirst(req, isNav, e));
  }
});
