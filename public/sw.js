// The Nanite Webshell's service worker: the app works offline once it has been opened online.
//   the page and its assets       precached at install (the page's own script and stylesheet are read from index.html)
//   Nanite (nanite.js / .wasm)    network first, the cached copy offline (so upstream updates still arrive)
//   root images (.tar.gz)         cache first: a root not yet unpacked can then start offline too
//   FragmentedFS roots (.ffs/)    blobs cache first (they never change: an interrupted first start resumes), metadata network first
//   VS Code (vscode/web/)         stale-while-revalidate: what VS Code has loaded once, it loads offline
//   our VS Code files (vscode/)   network first (3 s): the bootstrap and the nanite extension
//   the page itself (navigation)  network first (3 s), the cached page offline
// Not cached: the Docker builder's status, the Wisp router, the VS Code marketplace (they need the network anyway).
const VERSION = "v3";
const SHELL = `nanite-shell-${VERSION}`, RUNTIME = "nanite-runtime", ROOTS = "nanite-roots";
const BASE = new URL("./", self.location).href;
const NANITE = "https://packages.sparkpowered.org/lib/nanitevisor/";

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    const html = await (await fetch(BASE, { cache: "no-cache" })).text();
    const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((m) => new URL(m[1], BASE).href);
    await shell.addAll([BASE, ...assets, "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"].map((u) => new URL(u, BASE).href));
    await shell.put(new URL("index.html", BASE).href, await shell.match(BASE));
    // Nanite too, so a first offline start after one online visit has it even if the page never loaded it yet.
    const rt = await caches.open(RUNTIME);
    await Promise.all(["nanite.js", "nanite.wasm", "vkernel.wasm"].map((f) => rt.add(NANITE + f).catch(() => {})));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("nanite-shell-") && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
async function networkFirst(req, cacheName, ms) {
  const cache = await caches.open(cacheName);
  try {
    const res = await (ms ? Promise.race([fetch(req), timeout(ms)]) : fetch(req));
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
    if (hit) return hit;
    throw e;
  }
}
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName), hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}
async function staleWhileRevalidate(req, cacheName, e) {
  const cache = await caches.open(cacheName), hit = await cache.match(req);
  const update = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()).catch(() => {}); return res; });
  if (hit) { e.waitUntil(update.catch(() => {})); return hit; }
  return update;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate" && url.href.startsWith(BASE) && !url.pathname.includes("/vscode/")) {
    e.respondWith(networkFirst(req, SHELL, 3000).catch(async () => (await caches.match(new URL("index.html", BASE).href)) ?? Response.error()));
    return;
  }
  if (url.href.startsWith(NANITE)) { e.respondWith(networkFirst(req, RUNTIME)); return; }
  if (!url.href.startsWith(BASE)) return;
  const path = url.href.slice(BASE.length);
  if (path.startsWith("assets/") || path.startsWith("icons/")) e.respondWith(cacheFirst(req, SHELL));
  else if (/^roots\/[^/]+\.tar\.gz$/.test(path) || /^api\/docker\/[^/]+\.tar\.gz$/.test(path)) e.respondWith(cacheFirst(req, RUNTIME));
  else if (/^roots\/[^/]+\.ffs\/blobs\/[0-9a-f]+$/.test(path)) e.respondWith(cacheFirst(req, ROOTS));   // never change
  else if (/^roots\/[^/]+\.ffs\//.test(path)) e.respondWith(networkFirst(req, ROOTS, 5000));            // metadata.pack.*, hardlinks.json
  else if (path.startsWith("vscode/web/")) e.respondWith(staleWhileRevalidate(req, RUNTIME, e));
  else if (path.startsWith("vscode/")) e.respondWith(networkFirst(req, RUNTIME, 3000));   // our bootstrap and extension: changes show at once
  else if (path === "manifest.webmanifest" || path === "" || path === "index.html") e.respondWith(networkFirst(req, SHELL, 3000));
});
