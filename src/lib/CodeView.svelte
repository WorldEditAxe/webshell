<!-- A Code tab: VS Code for the Web (public/vscode: Microsoft's build plus the "nanite" extension) in an iframe, with the machine
     as its backend. The extension asks this page over a BroadcastChannel; files are served from the guest's file server
     (lib/files.ts), terminals are ptys of the machine. -->
<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { LoaderCircle } from "@lucide/svelte";
  import { GuestFiles } from "./files";
  import * as M from "./machine";
  import { proxiedUrl, unproxiedUrl } from "./preview";

  type Pty = (argv: string[], env: string[], size: { cols: number; rows: number }, sink: (b: Uint8Array) => void, onExit?: () => void) => Promise<number>;
  let { nv, sh, active, openPty, closePty, fileServer, info, onstorage, codeMode = false, ondisablemode }: {
    nv: M.Nanite; sh: M.Shells; active: boolean; openPty: Pty; closePty: (termId: number) => void;
    fileServer: { acquire(): Promise<void>; release(): void };
    /** What the remote indicator shows: the root's name and the machine's memory. */
    info: () => { root: string; memory: number };
    /** Opens the page's Storage settings (switching roots). */
    onstorage: () => void;
    /** VS Code mode: this VS Code is the whole page (the extension then offers to leave it), and how to leave it. */
    codeMode?: boolean; ondisablemode?: () => void;
  } = $props();

  const machine = untrack(() => nv);   // one machine per mount: the tab closes with it
  const files = new GuestFiles(machine);
  const session = Math.random().toString(36).slice(2, 10);
  const enc = new TextEncoder();
  let src = $state(""), error = $state(""), frame = $state<HTMLIFrameElement>();
  let folder = "/root";
  const url = () => `vscode/index.html?session=${session}&folder=${encodeURIComponent(folder)}`;
  const ptys = new Set<number>();

  type Req = { id: string; op: string; path?: string; [k: string]: unknown };
  const fail = (e: unknown) => { const message = (e as Error)?.message ?? String(e); return { message, code: /No such file/.test(message) ? "FileNotFound" : undefined }; };
  const exists = (p: string) => files.stat(p).then(() => true, () => false);

  async function handle(m: Req): Promise<unknown> {
    const p = m.path ?? "/";
    switch (m.op) {
      case "stat": return files.stat(p);
      case "ls": return (await files.ls(p)).map((e) => ({ name: e.name, dir: e.dir }));
      case "read": return files.read(p);
      case "write": {
        if (!m.create || !m.overwrite) {
          const there = await exists(p);
          if (!there && !m.create) throw new Error(`${p}: No such file or directory`);
          if (there && !m.overwrite) throw new Error(`${p}: File exists`);
        }
        return files.write(p, m.data as Uint8Array);
      }
      case "mkdir": return files.mkdir(p);
      case "rm": return files.rm(p);
      case "mv": {
        if (!m.overwrite && (await exists(m.to as string))) throw new Error(`${m.to}: File exists`);
        return files.mv(p, m.to as string);
      }
      case "ptyOpen": {
        // The root's login shell as the session leader, in the folder (see shells() in lib/machine.ts).
        const dec = new TextDecoder();
        let id = -1;
        const cwd = (m.cwd as string) || "/root";
        id = await openPty(sh.term(cwd), sh.termEnv(cwd), { cols: m.cols as number, rows: m.rows as number },
          (b) => bc.postMessage({ ev: "out", pty: id, data: dec.decode(b, { stream: true }) }),
          () => { ptys.delete(id); bc.postMessage({ ev: "exit", pty: id, code: 0 }); });
        ptys.add(id);
        return id;
      }
      case "ptyInput": machine.stdin(enc.encode(m.data as string), m.pty as number); return null;
      case "ptyResize": machine.resize(m.cols as number, m.rows as number, m.pty as number); return null;
      case "ptyClose": ptys.delete(m.pty as number); closePty(m.pty as number); return null;
      // The remote menu (public/vscode/nanite/extension.js).
      case "info": return { ...info(), codeMode };
      // After the answer is sent: leaving VS Code mode unmounts this view (and closes the channel).
      case "disableCodeMode": setTimeout(() => ondisablemode?.()); return null;
      case "openFolder": folder = (m.path as string) || "/root"; src = url(); return null;
      case "storage": onstorage(); return null;
      // The Simple Browser's address for a URL: through the Web Browser tab's proxy (the machine's ports and the web).
      case "proxiedUrl": return proxiedUrl(String(m.url ?? ""));
      case "unproxiedUrl": return unproxiedUrl(String(m.url ?? ""));
    }
    throw new Error(`unknown call ${m.op}`);
  }
  const bc = new BroadcastChannel(`nanite-vscode-${session}`);
  bc.onmessage = ({ data: m }: MessageEvent<Req>) => {
    if (!m?.id || !m.op) return;
    handle(m).then((value) => bc.postMessage({ id: m.id, ok: true, value }), (e) => bc.postMessage({ id: m.id, ok: false, error: fail(e) }));
  };

  onMount(() => {
    let closed = false;
    // The file server first, so the workbench finds its folder when it starts.
    fileServer.acquire().then(
      () => { if (!closed) src = url(); },
      (e) => { error = (e as Error).message; },
    );
    return () => {
      closed = true; bc.close();
      for (const id of ptys) closePty(id);
      fileServer.release();
    };
  });
  $effect(() => { if (active && src) requestAnimationFrame(() => frame?.focus()); });
</script>

<div class="absolute inset-0 bg-bg" class:invisible={!active} role="tabpanel">
  {#if src}
    <iframe bind:this={frame} {src} title="VS Code" class="h-full w-full border-0" allow="clipboard-read; clipboard-write"></iframe>
  {:else}
    <div class="grid h-full place-items-center text-xs text-muted">
      <div class="grid justify-items-center gap-2">
        {#if error}<p class="text-danger">{error}</p>{:else}<LoaderCircle size={18} class="animate-spin text-sakura" /><p>starting the file server on the machine…</p>{/if}
      </div>
    </div>
  {/if}
</div>
