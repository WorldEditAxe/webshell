// npm run single (tools/build-single.mjs): the page for single/nanite-webshell.html. Everything is inlined (fonts and icons as
// data: URLs, one script, one stylesheet); tools/build-single.mjs then puts the script and stylesheet into the HTML. The
// embedded Nanite and root come from cache/single/assets.json as the module virtual:single (src/lib/single.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

const icon = `data:image/svg+xml;base64,${readFileSync("public/icons/icon.svg").toString("base64")}`;

export default defineConfig({
  base: "./",
  define: { __SINGLE__: "true" },
  plugins: [tailwindcss(), svelte(), {
    name: "single",
    enforce: "pre",
    // Left out, not only hidden: VS Code (lib/CodeView.svelte, lib/files.ts) and the Web Browser tab (lib/PreviewView.svelte,
    // lib/preview.ts: Scramjet, bare-mux) become the stubs in src/single/.
    resolveId: (id) => {
      if (id === "virtual:single") return "\0virtual:single";
      const stub = { "CodeView.svelte": "empty.svelte", "PreviewView.svelte": "empty.svelte", "preview": "preview.ts", "files": "files.ts" }[id.replace(/^\.\/(lib\/)?/, "")];
      return stub ? resolve("src/single", stub) : null;
    },
    load: (id) => (id === "\0virtual:single" ? `export default ${readFileSync("cache/single/assets.json", "utf8")};` : null),
    // No files beside the page: the icon inline, no manifest (the installable app needs the server's files).
    transformIndexHtml: (html) => html
      .replace(/<link rel="icon"[^>]*\.png"[^>]*>\n?/, "").replace(/<link rel="(apple-touch-icon|manifest)"[^>]*>\n?/g, "")
      .replace(/href="icons\/icon\.svg"/, `href="${icon}"`),
  }],
  build: {
    outDir: "single/build", emptyOutDir: true, copyPublicDir: false, target: "es2022", chunkSizeWarningLimit: 20000,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER, cssCodeSplit: false, modulePreload: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
