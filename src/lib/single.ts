// The single-file build (tools/build-single.mjs): Nanite and the root come from the page itself, gzipped, in
// <script type="application/x-nanite-b7" id="single-NAME"> as 7-bit text (b7() there), as blob: URLs (Nanite fetches its
// module, worker and wasm by URL) and a stream (the root's first start). virtual:single says what is there.
import assets from "virtual:single";

export const SINGLE = __SINGLE__;
export const single = assets;
type Name = keyof NonNullable<typeof assets>["files"];

// b7: each character below 128 is 7 bits; one from U+0100 is a special group (NUL, CR or "<", by index) and the next 7 bits,
// or (index 3) a special group that ends the data.
const SPECIAL = [0, 13, 60];
function b7(text: string, size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(size));
  let acc = 0, bits = 0, n = 0;
  const put = (g: number) => { acc = (acc << 7) | g; bits += 7; if (bits >= 8) { bits -= 8; if (n < size) out[n++] = (acc >> bits) & 255; acc &= (1 << bits) - 1; } };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) { put(c); continue; }
    const v = c - 0x100, s = v >> 7;
    if (s < 3) { put(SPECIAL[s]!); put(v & 127); } else put(SPECIAL[v & 127]!);
  }
  if (n !== size) throw new Error(`embedded file: ${n} of ${size} bytes`);
  return out;
}

/** The bytes of one embedded file, inflated. */
function inflate(name: Name): ReadableStream<Uint8Array> {
  const el = document.getElementById(`single-${name}`);
  if (!assets || !el) throw new Error(`the page has no embedded ${name}`);
  const gz = b7(el.textContent ?? "", assets.files[name]);
  return new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
}
// A blob: URL; from a file (file://) a data: URL, since Nanite's worker there cannot fetch the page's blob: URLs.
async function blobUrl(name: Name, type: string): Promise<string> {
  const blob = new Blob([await new Response(inflate(name)).arrayBuffer()], { type });
  if (location.protocol !== "file:" || type === "text/javascript") return URL.createObjectURL(blob);
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result as string); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
}

let urls: Promise<{ js: string; wasm: string; vkernel: string }> | null = null;
/** blob: URLs of nanite.js, nanite.wasm and vkernel.wasm. */
export function naniteUrls(): Promise<{ js: string; wasm: string; vkernel: string }> {
  return (urls ??= Promise.all([blobUrl("naniteJs", "text/javascript"), blobUrl("naniteWasm", "application/wasm"), blobUrl("vkernelWasm", "application/wasm")])
    .then(([js, wasm, vkernel]) => ({ js, wasm, vkernel })));
}
/** The root's tar (not gzipped). */
export const rootTar = (): ReadableStream<Uint8Array> => inflate("root");

let opfs: Promise<boolean> | null = null;
/** Whether the page may keep a disk (OPFS): not when opened from a file (file://) in Chrome. */
export const hasOpfs = (): Promise<boolean> => (opfs ??= navigator.storage?.getDirectory ? navigator.storage.getDirectory().then(() => true, () => false) : Promise.resolve(false));

let curl: Promise<string> | null = null;
/** A blob: URL of libcurl.js (playit.gg's API). */
export const libcurlUrl = (): Promise<string> => (curl ??= blobUrl("libcurl", "text/javascript"));
