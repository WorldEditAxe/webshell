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
type Controller = { init(): Promise<void>; createFrame(f?: HTMLIFrameElement): Frame; decodeUrl(u: string): string };
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

type PageWindow = Window & { eruda?: { init(o: object): void }; ChiiDevtoolsIframe?: HTMLIFrameElement };
const relays = new Map<Window, () => Window | null>();   // Chii front end -> the page it inspects

/** Puts the devtools `mode` into the page now shown in `page`, drawing into the sidebar frame `side`. */
export function attachDevtools(page: HTMLIFrameElement, side: HTMLIFrameElement, mode: Devtools): void {
  let w: PageWindow, doc: Document;
  try { w = page.contentWindow as PageWindow; doc = w.document; } catch { return; }
  if (!doc?.documentElement || (w as unknown as { __naniteDevtools?: boolean }).__naniteDevtools) return;
  (w as unknown as { __naniteDevtools?: boolean }).__naniteDevtools = true;
  const script = doc.createElement("script");
  if (mode === "chii") {
    w.ChiiDevtoolsIframe = side;
    if (side.contentWindow) relays.set(side.contentWindow, () => page.contentWindow);
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeName === "STYLE" && CHII_RULE.test(n.textContent ?? "")) (n as Element).remove(); })
      .observe(doc.documentElement, { childList: true, subtree: true });
    script.setAttribute("embedded", "true"); script.setAttribute("cdn", CHII);
    script.src = `${CHII}/target.js`;
  } else {
    script.src = ERUDA;
    script.onload = () => {
      const sd = side.contentDocument;
      if (!sd?.body) return;
      sd.body.replaceChildren();
      const el = sd.createElement("div");
      sd.body.appendChild(el);
      w.eruda?.init({ container: el, inline: true, useShadowDom: false, autoScale: false, defaults: { theme: "Dark", displaySize: 100 } });
    };
  }
  (doc.head ?? doc.documentElement).appendChild(script);
}
window.addEventListener("message", (e) => {
  if (typeof e.data !== "string" || e.origin !== location.origin || !e.source) return;
  relays.get(e.source as Window)?.()?.postMessage(e.data, "*");
});
