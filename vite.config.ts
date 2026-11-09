// npm run build -> dist/ (served by server.mjs, with public/roots/ for the Ubuntu image). npm run dev: Vite's dev server.
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), svelte()],
  // public/ is only the root image (36 MB): the dev server serves it, the build leaves it where it is.
  build: { outDir: "dist", emptyOutDir: true, copyPublicDir: false, target: "es2022", chunkSizeWarningLimit: 1000 },
});
