// The Nanite Webshell's service worker: the app works offline once it has been opened online.
//   the page and its assets       precached at install (the page's own script and stylesheet are read from index.html)
//   Nanite (nanite.js / .wasm)    network first, the cached copy offline (so upstream updates still arrive)
//   root images (.tar.gz)         cache first: a root not yet unpacked can then start offline too
//   FragmentedFS roots (.ffs/)    blobs cache first (they never change: an interrupted first start resumes), metadata network first
//   VS Code (vscode/web/)         stale-while-revalidate: what VS Code has loaded once, it loads offline
//   our VS Code files (vscode/)   network first (3 s): the bootstrap and the nanite extension
//   the page itself (navigation)  network first (3 s), the cached page offline
//   preview/...                   not cached: Preview tabs, through Scramjet (below)
// Not cached: the Docker builder's status, the Wisp router, the VS Code marketplace (they need the network anyway).
const VERSION = "v12";
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

// ---- Preview tabs (src/lib/PreviewView.svelte, src/lib/preview.ts): Scramjet ----------------------------------------------
// BASE/preview/... is Scramjet's prefix: it rewrites the pages it serves there and fetches through bare-mux, whose transport
// (proxy/nanite-transport.mjs) sends localhost to the machine and the rest of the web over Wisp. Its config (the prefix, set by
// the page's ScramjetController) is in IndexedDB.
importScripts("proxy/scramjet.all.js");
const { ScramjetServiceWorker } = $scramjetLoadWorker();
// Made at the first preview request, not here: its constructor opens Scramjet's IndexedDB without creating the stores, and a
// database opened that way first stays without them (the page's ScramjetController creates them, before any preview).
let scramjet = null;
const PREVIEW_PATH = new URL("preview/", BASE).pathname;
// Scramjet's rewriter: its service worker serves this file itself (as the script that loads the rewriter into each page).
const SCRAMJET_WASM = new URL("proxy/scramjet.wasm.wasm", BASE).pathname;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** Where an error came from, by the prefix the transport (proxy/nanite-transport.mjs) gives it, and its message. */
function cause(trace) {
  const first = String(trace).split("\n").find((l) => l.trim()) ?? "";
  const msg = first.replace(/^\s*(Uncaught )?(\w*Error|Error):\s*/, "");
  if (/Nanite:/.test(msg)) return { from: "Nanite (the machine's network)", message: msg.replace(/^.*?Nanite:\s*/, "") };
  if (/libcurl \(Wisp\):/.test(msg)) return { from: "libcurl.js over the Wisp relay", message: msg.replace(/^.*?libcurl \(Wisp\):\s*/, "") };
  if (/no bare clients|bare-?mux|transport/i.test(msg)) return { from: "bare-mux (the proxy's transport)", message: msg };
  return { from: "Scramjet (the proxy)", message: msg || "unknown error" };
}
/** A browser-style error page (light, plain), with a Reload button, instead of Scramjet's stack trace; the cause below it. */
function errorPage(site, line, code, trace = "") {
  const c = trace ? cause(trace) : null;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>${site}</title>
<style>body{margin:0;font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#202124;background:#fff}
main{max-width:600px;margin:14vh auto 0;padding:0 24px}svg{width:72px;height:72px;margin-bottom:28px;fill:#9aa0a6}
h1{font-size:24px;font-weight:500;margin:0 0 14px}p{margin:0 0 8px;color:#5f6368}code{font-size:12px;color:#5f6368;letter-spacing:.02em}
button{margin-top:34px;padding:9px 24px;border:0;border-radius:20px;background:#1a73e8;color:#fff;font:500 14px system-ui,sans-serif;cursor:pointer}
button:hover{background:#1765cc}.cause{margin:14px 0 10px;padding:10px 12px;border-radius:8px;background:#f1f3f4;color:#3c4043;font-size:13px;word-break:break-word}
.cause span{font-weight:600}details{margin-top:14px;font-size:12px;color:#5f6368}summary{cursor:pointer}pre{white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;background:#f8f9fa;padding:10px;border-radius:8px}</style>
<main><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 14H4V8h16v10zM6 10h2v2H6zm0 4h8v2H6zm4-4h8v2h-8z"/></svg>
<h1>This site can’t be reached</h1><p><b>${esc(site)}</b>${line}</p>
${c ? `<p class="cause"><span>${esc(c.from)}:</span> ${esc(c.message)}</p>` : ""}<code>${code}</code>
${trace ? `<details><summary>Details</summary><pre>${esc(trace)}</pre></details>` : ""}<br><button onclick="location.reload()">Reload</button></main></html>`;
  return new Response(html, { status: 502, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
/** Chrome's wording for a failed connection, from the error's message. */
function netError(message) {
  if (/refused|not running/i.test(message)) return [" refused to connect.", "ERR_CONNECTION_REFUSED"];
  if (/time ?out|timed out/i.test(message)) return [" took too long to respond.", "ERR_CONNECTION_TIMED_OUT"];
  if (/resolve host|name.*resolv|ENOTFOUND/i.test(message)) return ["’s server IP address could not be found.", "ERR_NAME_NOT_RESOLVED"];
  if (/SSL|TLS|certificate/i.test(message)) return [" sent an invalid response.", "ERR_SSL_PROTOCOL_ERROR"];
  if (/reset|closed/i.test(message)) return [" unexpectedly closed the connection.", "ERR_CONNECTION_CLOSED"];
  if (/not an HTTP|EPROTO/i.test(message)) return [" sent an invalid response.", "ERR_INVALID_HTTP_RESPONSE"];
  if (/wisp|websocket/i.test(message)) return [" can't be reached: the network (Wisp) is down.", "ERR_INTERNET_DISCONNECTED"];
  if (/no bare clients|transport/i.test(message)) return [" can't be reached: the webshell that fetches it was closed or reloaded.", "ERR_CONNECTION_CLOSED"];
  return [" can't be reached right now.", "ERR_FAILED"];
}
async function previewFetch(e) {
  scramjet ??= new ScramjetServiceWorker();
  await scramjet.loadConfig();
  const res = await scramjet.fetch(e);
  // Scramjet's own error page (a stack trace): the browser's kind instead.
  if (res.status >= 500 && /text\/html/.test(res.headers.get("content-type") ?? "") && e.request.mode === "navigate") {
    const text = await res.clone().text();
    if (text.includes("<title>Scramjet</title>") && text.includes("errorTrace.value")) {
      // Its script (with the trace and the URL) is in the page as a data: URL, URL-encoded.
      let script = text;
      const data = /src="data:application\/javascript,([^"]*)"/.exec(text)?.[1];
      if (data) { try { script = decodeURIComponent(data.replace(/&amp;/g, "&")); } catch {} }
      const trace = JSON.parse(/errorTrace\.value = ("(?:[^"\\]|\\.)*")/.exec(script)?.[1] ?? '""');
      const url = JSON.parse(/fetchedURL\.textContent = ("(?:[^"\\]|\\.)*")/.exec(script)?.[1] ?? '""');
      let site = url; try { site = new URL(url).host; } catch {}
      const [line, code] = netError(trace);
      return errorPage(site || "This site", line, code, trace);
    }
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && (url.pathname.startsWith(PREVIEW_PATH) || url.pathname === SCRAMJET_WASM)) { e.respondWith(previewFetch(e)); return; }
  const res = ordinary(e);
  if (res) e.respondWith(res);
});
/** The response for a request outside the Preview tabs, or undefined to leave it to the network. */
function ordinary(e) {
  const req = e.request;
  if (req.method !== "GET") return undefined;
  const url = new URL(req.url);
  if (req.mode === "navigate" && url.href.startsWith(BASE) && !url.pathname.includes("/vscode/")) {
    return networkFirst(req, SHELL, 3000).catch(async () => (await caches.match(new URL("index.html", BASE).href)) ?? Response.error());
  }
  if (url.href.startsWith(NANITE)) return networkFirst(req, RUNTIME);
  if (!url.href.startsWith(BASE)) return undefined;
  const path = url.href.slice(BASE.length);
  if (path.startsWith("assets/") || path.startsWith("icons/")) return (cacheFirst(req, SHELL));
  if (/^roots\/[^/]+\.tar\.gz$/.test(path) || /^api\/docker\/[^/]+\.tar\.gz$/.test(path)) return (cacheFirst(req, RUNTIME));
  if (/^roots\/[^/]+\.ffs\/blobs\/[0-9a-f]+$/.test(path)) return (cacheFirst(req, ROOTS));   // never change
  if (/^roots\/[^/]+\.ffs\//.test(path)) return (networkFirst(req, ROOTS, 5000));            // metadata.pack.*, hardlinks.json
  if (path.startsWith("vscode/web/")) return (staleWhileRevalidate(req, RUNTIME, e));
  if (path.startsWith("vscode/")) return (networkFirst(req, RUNTIME, 3000));   // our bootstrap and extension: changes show at once
  if (path === "manifest.webmanifest" || path === "" || path === "index.html") return (networkFirst(req, SHELL, 3000));
  return undefined;
}
