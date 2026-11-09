import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@xterm/xterm/css/xterm.css";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";

// xterm.js measures the font when a terminal opens: have JetBrains Mono loaded first.
await Promise.all([document.fonts.load('13px "JetBrains Mono"'), document.fonts.load('bold 13px "JetBrains Mono"')]).catch(() => {});
mount(App, { target: document.getElementById("app")! });
// Offline: public/sw.js caches the app, Nanite, the root images and VS Code as they are used. Not in Vite's dev server.
if ("serviceWorker" in navigator && !import.meta.env.DEV) navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("service worker:", e));
