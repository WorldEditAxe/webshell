// npm run build -> dist/ (served by server.mjs, with public/roots/ for the Ubuntu image). npm run dev: Vite's dev server.
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  define: { __SINGLE__: "false" },
  // virtual:single (src/lib/single.ts) holds the single-file build's embedded Nanite and root (vite.single.config.ts); none here.
  plugins: [tailwindcss(), svelte(), {
    name: "single-stub",
    resolveId: (id) => (id === "virtual:single" ? "\0virtual:single" : null),
    load: (id) => (id === "\0virtual:single" ? "export default null;" : null),
  }],
  // public/ is only the root image (36 MB): the dev server serves it, the build leaves it where it is.
  build: { outDir: "dist", emptyOutDir: true, copyPublicDir: false, target: "es2022", chunkSizeWarningLimit: 1000 },
});
