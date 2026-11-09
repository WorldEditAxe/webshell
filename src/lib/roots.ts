// Root filesystems: the built-in images (public/roots, tools/make-root.sh: FragmentedFS stores, src/lib/ffsroot.ts), ones added in Storage (a Docker image the server
// builds, a URL, or a .tar.gz from this computer), and which one the machine runs. Each root has its own disk (Nanite's
// disk-backed root, OPFS directory nanite-root-<disk>), so switching keeps every root's changes.
export type RootSource = { kind: "url"; url: string } | { kind: "ffs"; url: string } | { kind: "docker"; image: string } | { kind: "file"; name: string };
export interface Root {
  id: string;
  name: string;
  /** Which logo / icon to show: ubuntu, debian, alpine, docker, file, link. */
  icon: string;
  /** The disk's name (rootName): the OPFS directory nanite-root-<disk>. */
  disk: string;
  source: RootSource;
  builtin?: boolean;
  /** The webshell edition: the Nanite Webshell's own extras (motd, ~/README.md, usage, ping, paint, the desktop installer). */
  demo?: boolean;
  note?: string;
}

const local = (file: string) => new URL(`roots/${file}`, location.href).href;
export const BUILTIN: Root[] = [
  { id: "ubuntu-demo", name: "Ubuntu 26.04 LTS", note: "webshell", icon: "ubuntu", disk: "ubuntu-26.04-v4", builtin: true, demo: true,
    source: { kind: "ffs", url: local("ubuntu-26.04-x86_64.ffs/") } },
  { id: "ubuntu", name: "Ubuntu 26.04 LTS", note: "plain", icon: "ubuntu", disk: "ubuntu-26.04-plain", builtin: true,
    source: { kind: "ffs", url: local("ubuntu-26.04-plain.ffs/") } },
  { id: "debian", name: "Debian 13", note: "trixie", icon: "debian", disk: "debian-13", builtin: true, source: { kind: "ffs", url: local("debian-13.ffs/") } },
  { id: "alpine", name: "Alpine Linux 3.22", icon: "alpine", disk: "alpine-3.22", builtin: true, source: { kind: "ffs", url: local("alpine-3.22.ffs/") } },
];

const KEY_ROOTS = "nanite-webshell:roots", KEY_CURRENT = "nanite-webshell:root";
const read = <T>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export const custom = (): Root[] => read<Root[]>(KEY_ROOTS, []);
export const all = (): Root[] => [...BUILTIN, ...custom()];
export function current(): Root {
  const q = new URLSearchParams(location.search).get("root");
  const id = q ?? read<string>(KEY_CURRENT, "ubuntu-demo");
  return all().find((r) => r.id === id) ?? BUILTIN[0]!;
}
export const select = (id: string) => write(KEY_CURRENT, id);

export function add(r: Omit<Root, "id" | "disk">): Root {
  const id = `${r.icon}-${Date.now().toString(36)}`;
  const root: Root = { ...r, id, disk: `custom-${id}` };
  write(KEY_ROOTS, [...custom(), root]);
  return root;
}
export function remove(id: string): void { write(KEY_ROOTS, custom().filter((r) => r.id !== id)); }
export function rename(id: string, name: string): void { write(KEY_ROOTS, custom().map((r) => (r.id === id ? { ...r, name } : r))); }

// ---- OPFS: the disks, and the .tar.gz of a root added from a file (kept until its first start unpacks it) ----
const opfs = () => navigator.storage.getDirectory();
export const diskDir = (disk: string) => `nanite-root-${disk}`;
const SOURCES = "nanite-webshell-sources";

/** Bytes a root's disk takes (0: not unpacked yet). */
export async function diskSize(disk: string): Promise<number> {
  try {
    const dir = await (await opfs()).getDirectoryHandle(diskDir(disk));
    let n = 0;
    for await (const h of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values())
      if (h.kind === "file") n += (await (h as FileSystemFileHandle).getFile()).size;
    return n;
  } catch { return 0; }
}
export async function estimate(): Promise<{ usage: number; quota: number }> {
  const e = await navigator.storage.estimate().catch(() => ({ usage: 0, quota: 0 }));
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}
export async function storeSource(id: string, file: File): Promise<void> {
  const dir = await (await opfs()).getDirectoryHandle(SOURCES, { create: true });
  const w = await (await dir.getFileHandle(`${id}.tar.gz`, { create: true })).createWritable();
  await file.stream().pipeTo(w);
}
export async function loadSource(id: string): Promise<File> {
  const dir = await (await opfs()).getDirectoryHandle(SOURCES);
  return (await dir.getFileHandle(`${id}.tar.gz`)).getFile();
}
export async function dropSource(id: string): Promise<void> {
  try { await (await (await opfs()).getDirectoryHandle(SOURCES)).removeEntry(`${id}.tar.gz`); } catch {}
}

// ---- Docker images, built into roots by the server (server.mjs /api/docker) ----
export type DockerStatus = { state: "none" | "queued" | "pulling" | "exporting" | "ready" | "error"; url?: string; size?: number; error?: string; image?: string };
export async function docker(image: string, start: boolean): Promise<DockerStatus> {
  const r = await fetch(new URL(`api/docker?image=${encodeURIComponent(image)}`, location.href), { method: start ? "POST" : "GET" });
  if (!r.ok) throw new Error(`the server has no Docker builder (HTTP ${r.status})`);
  return r.json();
}
/** Has the server build `image` into a root; resolves with its URL. */
export async function dockerBuild(image: string, progress: (s: DockerStatus) => void): Promise<string> {
  let s = await docker(image, true);
  for (;;) {
    progress(s);
    if (s.state === "ready") return new URL(s.url!, location.href).href;
    if (s.state === "error") throw new Error(s.error ?? "the build failed");
    await new Promise((r) => setTimeout(r, 1500));
    s = await docker(image, false);
  }
}
