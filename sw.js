// Offline shell: network first, cached copy when offline. Cross-origin (ntfy) is never cached.
// Requests revalidate with the server (cache: "no-cache") because GitHub Pages sends
// max-age=600, which would otherwise serve a stale app for 10 minutes after a deploy.
const CACHE = "cd-shell-v10";
const SHELL = ["./", "index.html", "app.js", "crypto.js", "db.js", "command.js", "setup.js", "style.css", "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    // A navigate-mode request cannot be cloned with a new cache mode, so rebuild it from the URL.
    fetch(new Request(e.request.url, { cache: "no-cache", credentials: "same-origin" }))
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request.url, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))),
  );
});
