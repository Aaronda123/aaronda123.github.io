// ==============================================================================================================
// CONTRACT – sw.js (owner: builder CORE). Spec: ARCHITECTURE.md §3.5.4 (bugs 39, 40).
// VERSION "jarvis-v2-<yyyymmddhhmm>" (bump on every deploy); caches `shell-${VERSION}` and `static-${VERSION}`.
// Same-origin navigations and .html/.js/.mjs/.css/.json/.webmanifest: network-first, cache fallback (no mixed
// module versions). icons/, media/, vendor/ and Google Fonts: cache-first. Everything else (Claude, Gemini, Azure,
// markets, weather, Wikipedia): network only, never cached.
// ==============================================================================================================
// Offline-Start: Die App-Dateien kommen frisch aus dem Netz und landen dabei im Cache; ohne Netz startet Jarvis aus
// dem Cache. Anfragen an Claude, Gemini, Azure, Kurse, Wetter und Wikipedia gehen nie über den Cache.

const VERSION = "jarvis-v2-202610131000";
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
];
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const NETWORK_FIRST = /\.(?:html|js|mjs|css|json|webmanifest)$/i;
const CACHE_FIRST = /\/(?:icons|media|vendor)\//;

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
        .filter((k) => k !== SHELL_CACHE && k !== STATIC_CACHE && !KEEP_PREFIXES.some((p) => k.startsWith(p)))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Schlüssel ohne ?…: „/?wake=1“ und „/“ sind dieselbe Seite, Pings landen nicht als neue Einträge im Cache.
function keyOf(url) {
  return url.origin + url.pathname;
}

async function networkFirst(req, isNav) {
  const cache = await caches.open(SHELL_CACHE);
  const url = new URL(req.url);
  const key = keyOf(url);
  try {
    const fresh = isNav
      ? new Request(url.href, { cache: "no-cache", credentials: "same-origin" })
      : new Request(req, { cache: "no-cache" });
    const res = await fetch(fresh);
    if (res && res.ok && res.type === "basic" && req.cache !== "no-store") {
      cache.put(key, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const hit = (await cache.match(key, { ignoreSearch: true })) || (await caches.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    if (isNav) {
      const page = (await cache.match("index.html", { ignoreSearch: true })) || (await cache.match("./"));
      if (page) return page;
    }
    return Response.error();
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
  if (url.origin === self.location.origin) {
    if (CACHE_FIRST.test(url.pathname)) {
      e.respondWith(cacheFirst(req));
      return;
    }
    const isNav = req.mode === "navigate";
    if (isNav || url.pathname.endsWith("/") || NETWORK_FIRST.test(url.pathname)) {
      e.respondWith(networkFirst(req, isNav));
    }
    return;
  }
  if (FONT_HOSTS.has(url.hostname)) e.respondWith(cacheFirst(req));
  // alles andere: kein respondWith → direkt ins Netz, nie in den Cache
});
