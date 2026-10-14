/* IronLog service worker.
   - Makes the app open with no signal (gym basements) by keeping a copy of its files.
   - The page itself (index.html) is fetched fresh when you're online, so updates you
     upload show up the next time you open the app. With no signal (or a very slow one,
     over 3 seconds) the saved copy opens instead.
   - Handles taps on the "workout in progress" notification.
   Your workout data is NOT in here: it lives in IndexedDB and this file never touches it,
   except to read whether a workout is still running (see notificationclose). */

const CACHE = "ironlog-v1"; // change the number only if you want to force-clear old saved files
const APP_FILES = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const PAGE_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Add one at a time so a single missing file can't stop the whole install.
    await Promise.all(APP_FILES.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("ironlog-") && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") { event.respondWith(pageNetworkFirst(req)); return; }
  if (url.origin === self.location.origin || FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event, req));
  }
});

async function pageNetworkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PAGE_TIMEOUT_MS)),
    ]);
    if (res && res.ok) await cache.put("./index.html", res.clone());
    return res;
  } catch (e) {
    return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
  }
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const update = fetch(req)
    .then((res) => { if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  if (cached) { event.waitUntil(update); return cached; }
  return (await update) || Response.error();
}

/* ---------- workout notification ---------- */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) { if ("focus" in w) return w.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow("./");
  })());
});

// If the notification is swiped away while a workout is still running, put it back.
// (Works in Chrome on Android/desktop. iPhone probably never sends this event - see notes.)
self.addEventListener("notificationclose", (event) => {
  const d = event.notification.data || {};
  if (!d.title) return;
  event.waitUntil((async () => {
    if (!(await workoutStillRunning())) return;
    await self.registration.showNotification(d.title, {
      body: d.body, tag: event.notification.tag, silent: true, requireInteraction: true,
      icon: "icon-192.png", badge: "icon-192.png", data: d,
    });
  })());
});

function workoutStillRunning() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open("ironlogDB"); } catch (e) { resolve(false); return; }
    req.onerror = () => resolve(false);
    req.onupgradeneeded = () => { req.transaction.abort(); resolve(false); }; // DB doesn't exist yet
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("activeWorkout")) { db.close(); resolve(false); return; }
      const get = db.transaction("activeWorkout", "readonly").objectStore("activeWorkout").get("current");
      get.onsuccess = () => { db.close(); resolve(!!get.result); };
      get.onerror = () => { db.close(); resolve(false); };
    };
  });
}
