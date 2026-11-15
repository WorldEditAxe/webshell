// The single-file build (tools/build-single.mjs): Nanite and the root come from the page itself (virtual:single), gzipped and
// base64 encoded, as blob: URLs (Nanite fetches its module, worker and wasm by URL) and a stream (the root's first start).
import assets from "virtual:single";

export const SINGLE = __SINGLE__;
export const single = assets;

/** The bytes of one embedded file, inflated. */
function inflate(b64: string): ReadableStream<Uint8Array> {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
}
// A blob: URL; from a file (file://) a data: URL, since Nanite's worker there cannot fetch the page's blob: URLs.
async function blobUrl(b64: string, type: string): Promise<string> {
  const blob = new Blob([await new Response(inflate(b64)).arrayBuffer()], { type });
  if (location.protocol !== "file:" || type === "text/javascript") return URL.createObjectURL(blob);
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result as string); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
}

let urls: Promise<{ js: string; wasm: string; vkernel: string }> | null = null;
/** blob: URLs of nanite.js, nanite.wasm and vkernel.wasm. */
export function naniteUrls(): Promise<{ js: string; wasm: string; vkernel: string }> {
  if (!assets) throw new Error("not the single-file build");
  const a = assets;
  return (urls ??= Promise.all([blobUrl(a.naniteJs, "text/javascript"), blobUrl(a.naniteWasm, "application/wasm"), blobUrl(a.vkernelWasm, "application/wasm")])
    .then(([js, wasm, vkernel]) => ({ js, wasm, vkernel })));
}
/** The root's tar (not gzipped). */
export function rootTar(): ReadableStream<Uint8Array> {
  if (!assets) throw new Error("not the single-file build");
  return inflate(assets.root);
}

let opfs: Promise<boolean> | null = null;
/** Whether the page may keep a disk (OPFS): not when opened from a file (file://) in Chrome. */
export const hasOpfs = (): Promise<boolean> => (opfs ??= navigator.storage?.getDirectory ? navigator.storage.getDirectory().then(() => true, () => false) : Promise.resolve(false));

let curl: Promise<string> | null = null;
/** A blob: URL of libcurl.js (playit.gg's API). */
export const libcurlUrl = (): Promise<string> => (curl ??= blobUrl(assets!.libcurl, "text/javascript"));
