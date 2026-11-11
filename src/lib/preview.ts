// Preview tabs: a small browser in the webshell, on Scramjet (github.com/MercuryWorkshop/scramjet, a service-worker web proxy).
// Scramjet rewrites the pages it shows under BASE/preview/ (public/sw.js) and fetches through bare-mux, whose transport
// (public/proxy/nanite-transport.mjs) sends
//   localhost / 127.0.0.1 / 10.0.2.15   to the machine: over a MessagePort to this page, which uses Nanite's network.fetch;
//   everything else                     to the web: libcurl.js over the machine's Wisp relay (TLS in the browser).
// Not supported: WebSockets to the machine (a dev server's live reload), streamed responses from the machine.
// bare-mux's worker is shared by this origin's windows: the last webshell window opened answers for "localhost".
import { BareMuxConnection } from "@mercuryworkshop/bare-mux";
import type { Nanite } from "./machine";

const base = () => new URL("./", location.href);
/** Whether previews can work here: they need the service worker (not in Vite's dev server). */
export const previewSupported = () => "serviceWorker" in navigator && !import.meta.env.DEV;

type Frame = {
  frame: HTMLIFrameElement; url: URL;
  go(url: string): void; back(): void; forward(): void; reload(): void;
  addEventListener(type: "urlchange" | "navigate", f: (e: { url: string }) => void): void;
};
type Controller = { init(): Promise<void>; createFrame(f?: HTMLIFrameElement): Frame; decodeUrl(u: string): string; encodeUrl(u: string | URL): string };
declare global { var $scramjetLoadController: () => { ScramjetController: new (c: object) => Controller } }

let ready: Promise<Controller> | null = null, setWisp = "";
let machine: () => Nanite | null = () => null, wisp: () => string | null = () => null;

/** The Wisp relay previews use now, or null before the machine has one. */
export const currentWisp = () => wisp();
/** Where previews get the machine and the Wisp relay from (the page's current machine; set once). */
export function servePreviews(m: () => Nanite | null, w: () => string | null): void { machine = m; wisp = w; }

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}
/** Answers the transport's requests for the machine. */
function machinePort(): MessagePort {
  const ch = new MessageChannel();
  ch.port1.onmessage = async ({ data: m }) => {
    try {
      const nv = machine();
      if (!nv) throw new Error("connection refused: the machine is not running");
      const res = await nv.network.fetch(m.port, m.path, { method: m.method, headers: m.headers, body: m.body ? new Uint8Array(m.body) : null }, { timeout: 40000 });
      const body = await res.arrayBuffer();
      ch.port1.postMessage({ id: m.id, status: res.status, statusText: res.statusText, headers: [...res.headers], body }, [body]);
    } catch (e) {
      ch.port1.postMessage({ id: m.id, error: (e as Error)?.message ?? String(e) });
    }
  };
  return ch.port2;
}
/** (Re)sets bare-mux's transport: ours, with this page's machine and the current Wisp relay. */
async function transport(w: string): Promise<void> {
  const conn = new BareMuxConnection(new URL("proxy/baremux.js", base()).href);
  const port = machinePort();
  await conn.setTransport(new URL("proxy/nanite-transport.mjs", base()).href, [{ wisp: w.endsWith("/") ? w : `${w}/`, port }], [port]);
  setWisp = w;
}
/** Deletes Scramjet's database if it exists without its stores (an earlier service worker opened it first): Scramjet would
 *  open it as it is and fail ("One of the specified object stores was not found"); deleted, it is made again with them. */
async function repairDb(): Promise<void> {
  const open = () => new Promise<IDBDatabase | null>((resolve) => {
    const r = indexedDB.open("$scramjet");
    r.onupgradeneeded = () => { r.transaction?.abort(); resolve(null); };   // did not exist: leave it to Scramjet
    r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null);
  });
  const db = await open();
  if (!db) return;
  const ok = ["config", "cookies", "redirectTrackers", "referrerPolicies", "publicSuffixList"].every((n) => db.objectStoreNames.contains(n));
  db.close();
  if (ok) return;
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.deleteDatabase("$scramjet");
    r.onsuccess = () => resolve();
    r.onerror = () => reject(new Error("could not reset the proxy's database"));
    r.onblocked = () => reject(new Error("the proxy's database is in use: reload the page once"));
  });
}
/** The address of `url` through the proxy (the machine's pages and the web, as the Web Browser tab loads them): for VS Code's
 *  Simple Browser, forwarded ports and localhost links (public/vscode/index.html and the nanite extension ask for it). */
export async function proxiedUrl(url: string): Promise<string> {
  const c = await proxy();
  return new URL(c.encodeUrl(url), location.href).href;
}
/** The real address of a proxied one (what the page in a proxied frame is at). */
export async function unproxiedUrl(url: string): Promise<string> {
  const c = await proxy();
  try { return c.decodeUrl(url); } catch { return url; }
}
/** Scramjet, ready to make frames (loaded the first time a Preview tab needs it). */
export function proxy(): Promise<Controller> {
  const w = wisp();
  if (ready && w && w !== setWisp) ready = ready.then(async (c) => { await transport(w); return c; });
  return (ready ??= (async () => {
    await navigator.serviceWorker.ready;
    await loadScript(new URL("proxy/scramjet.all.js", base()).href);
    await repairDb();
    const { ScramjetController } = $scramjetLoadController();
    const at = (f: string) => new URL(`proxy/${f}`, base()).pathname;
    const c = new ScramjetController({
      prefix: new URL("preview/", base()).pathname,
      files: { wasm: at("scramjet.wasm.wasm"), all: at("scramjet.all.js"), sync: at("scramjet.sync.js") },
    });
    await c.init();
    const ws = wisp();
    if (!ws) throw new Error("the network (Wisp) is not connected yet");
    await transport(ws);
    return c;
  })().catch((e) => { ready = null; throw e; }));
}

// ---- Devtools for a Preview tab, in a sidebar beside its page ----------------------------------------------------------------
// Put into the page after each load (from this window: the frame is this origin's):
//   eruda   Eruda, inline, drawn into the sidebar's own blank document (an iframe), without a shadow root: all of its CSS goes
//           there. (With a shadow root Eruda writes its font and base rules into the inspected page's <head>.)
//   chii    Chii's embedded Chrome DevTools: its front end goes into the sidebar's iframe (window.ChiiDevtoolsIframe) instead of
//           a panel over the page. The front end posts to its parent, this window, which passes the messages on to the page.
export type Devtools = "eruda" | "chii";
export const DEVTOOLS: Record<Devtools, string> = { eruda: "Eruda", chii: "Chrome DevTools" };
/** The blank document Eruda draws into: Eruda sets "all: initial" on its container, so its size comes from here. */
export const ERUDA_DOC = `<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#1a1619;overflow:hidden}` +
  `#eruda{display:block!important;position:relative!important;height:100%!important;width:100%!important}</style></head><body></body></html>`;
const ERUDA = "https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.js";
const CHII = "https://cdn.jsdelivr.net/npm/chii@1.15.5/public";
// Chii's embedded mode adds "html, body { overflow-y: auto; box-sizing: border-box }" to the page, for the panel it would put over
// it; its panel is in the sidebar here, so the rule only changes the page's layout: it is removed as soon as it is added.
const CHII_RULE = /^\s*html,\s*body\s*\{\s*overflow-y:\s*auto;\s*box-sizing:\s*border-box;?\s*\}\s*$/;

type PageWindow = Window & { eruda?: { init(o: object): void } };
// Each Web Browser tab's Chii: its page frame, its sidebar frame now (the sidebar's frame is re-created when the devtools are turned
// on or switched, possibly after the page has loaded), and the front end's address. Chii keeps the frame it was given at its
// start, so it gets a stand-in (`frame`) that always means the sidebar's frame now; a new sidebar frame gets the front end too.
type Chii = { page: HTMLIFrameElement; side: () => HTMLIFrameElement | undefined; url: string; frame: object };
const chiis = new Map<HTMLIFrameElement, Chii>();

// The page runs under Scramjet, which rewrites every script the page loads and hooks the page's DOM and URL APIs. The devtools
// must not be rewritten (Chii breaks: "function call() is not a constructor"), so their <script> is made and inserted with this
// window's own DOM functions, which Scramjet has not hooked: the browser loads it straight from the CDN and runs it as it is.
const native = {
  create: Document.prototype.createElement,
  attr: Element.prototype.setAttribute,
  src: Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src")!.set!,
  append: Node.prototype.appendChild,
  frameSrc: Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src")!.set!,
};
// Scramjet's URL.createObjectURL in the page turns blob:<this origin>/ID into blob:<the proxied site>/ID, which nothing can load.
// Chii opens its front end at such a URL: the stand-in takes it back to the real one.
const realBlob = (v: unknown) => String(v).replace(/^blob:[^/]+\/\/[^/]+\//, `blob:${location.origin}/`);
function chiiOf(page: HTMLIFrameElement, side: () => HTMLIFrameElement | undefined): Chii {
  let c = chiis.get(page);
  if (c) { c.side = side; return c; }
  const show = (cc: Chii) => { const f = cc.side(); if (f && cc.url && f.getAttribute("src") !== cc.url) native.frameSrc.call(f, cc.url); };
  const cc: Chii = { page, side, url: "", frame: {} };
  cc.frame = {
    get src() { return cc.url; },
    set src(v: unknown) { cc.url = realBlob(v); show(cc); },
    setAttribute(name: string, v: string) { if (name.toLowerCase() === "src") { cc.url = realBlob(v); show(cc); } },
    getAttribute(name: string) { return name.toLowerCase() === "src" ? cc.url : null; },
    get contentWindow() { return cc.side()?.contentWindow ?? null; },
    style: {},
  };
  chiis.set(page, cc);
  return cc;
}
/** A (new) sidebar frame for the tab of `page`: it shows the Chii front end the page already has, if any. */
export function sidebarChanged(page: HTMLIFrameElement | undefined): void {
  const c = page && chiis.get(page), f = c?.side();
  if (c && f && c.url && f.getAttribute("src") !== c.url) native.frameSrc.call(f, c.url);
}

/** Puts the devtools `mode` into the page now shown in `page`, drawing into the sidebar frame `side`. */
export function attachDevtools(page: HTMLIFrameElement, sideNow: () => HTMLIFrameElement | undefined, mode: Devtools): void {
  let w: PageWindow, doc: Document;
  try { w = page.contentWindow as PageWindow; doc = w.document; } catch { return; }
  if (!doc?.documentElement || (w as unknown as { __naniteDevtools?: boolean }).__naniteDevtools) return;
  (w as unknown as { __naniteDevtools?: boolean }).__naniteDevtools = true;
  const script = native.create.call(doc, "script") as HTMLScriptElement;
  if (mode === "chii") {
    const c = chiiOf(page, sideNow);
    c.url = "";   // a new page: its Chii opens a new front end
    (w as unknown as { ChiiDevtoolsIframe: object }).ChiiDevtoolsIframe = c.frame;
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeName === "STYLE" && CHII_RULE.test(n.textContent ?? "")) (n as Element).remove(); })
      .observe(doc.documentElement, { childList: true, subtree: true });
    native.attr.call(script, "embedded", "true"); native.attr.call(script, "cdn", CHII);
    native.src.call(script, `${CHII}/target.js`);
    // Chii finds its own <script> by its src (".../target.js") to read embedded and cdn from it. In the page, Scramjet's src getter
    // "un-proxies" every address by cutting off as many characters as the proxy's prefix (this origin + /preview/) is long: on a
    // long origin (a tunnel's) nothing of the CDN address is left, Chii finds no script and starts without its sidebar. This
    // script tells its real address itself.
    Object.defineProperty(script, "src", { configurable: true, get: () => `${CHII}/target.js` });
  } else {
    native.src.call(script, ERUDA);
    script.onload = () => {
      const sd = sideNow()?.contentDocument;
      if (!sd?.body) return;
      sd.body.replaceChildren();
      const el = sd.createElement("div");
      sd.body.appendChild(el);
      w.eruda?.init({ container: el, inline: true, useShadowDom: false, autoScale: false, defaults: { theme: "Dark", displaySize: 100 } });
    };
  }
  native.append.call(doc.head ?? doc.documentElement, script);
}
/** Passes a Chii front end's message (posted to the window holding its sidebar) on to the page it inspects. */
export function relayDevtools(e: MessageEvent): void {
  if (typeof e.data !== "string" || e.origin !== location.origin || !e.source) return;
  const c = [...chiis.values()].find((x) => x.side()?.contentWindow === e.source), page = c?.page.contentWindow;
  if (!page) return;
  // Scramjet's postMessage in the page would wrap the message as if from the proxied site, and its MessageEvent then reports
  // that site as the origin, which Chii's check (origin == this page's) refuses. So: this window's own postMessage, with the
  // message already in Scramjet's wrapper and this page's origin: the page sees the message as it was, from where it came.
  const post = window.postMessage as (this: Window, m: unknown, o: string) => void;
  post.call(page, { $scramjet$messagetype: "window", $scramjet$origin: location.origin, $scramjet$data: e.data }, "*");
}
window.addEventListener("message", relayDevtools);

/** For VS Code's Web Browser panel (public/vscode/nanite/extension.js, a webview of this origin): the Web Browser tab's devtools. */
export const devtoolsForFrames = {
  names: DEVTOOLS, erudaDoc: ERUDA_DOC,
  attach: (page: HTMLIFrameElement, side: HTMLIFrameElement, mode: Devtools) => attachDevtools(page, () => side, mode),
  relay: relayDevtools,
};
