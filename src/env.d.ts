/** true in the single-file build (vite.single.config.ts, tools/build-single.mjs). */
declare const __SINGLE__: boolean;
declare module "virtual:single" {
  /** The single-file build's embedded files, gzipped and base64 encoded; null in the normal build. */
  const assets: { naniteJs: string; naniteWasm: string; vkernelWasm: string; root: string; libcurl: string; rootName: string; rootDisk: string; rootBytes: number } | null;
  export default assets;
}
