/** true in the single-file build (vite.single.config.ts, tools/build-single.mjs). */
declare const __SINGLE__: boolean;
declare module "virtual:single" {
  /** The single-file build's embedded files: each one's gzipped size (its bytes are in <script id="single-NAME">); null in the
   *  normal build. */
  const assets: {
    files: { naniteJs: number; naniteWasm: number; vkernelWasm: number; root: number; libcurl: number };
    rootName: string; rootDisk: string; rootBytes: number;
  } | null;
  export default assets;
}
