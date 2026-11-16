// A folder on this computer in the machine, at ~/disk: Nanite's "dir" mount copies the folder in when the machine starts and
// writes the machine's changes back to it (new, changed and deleted files; modes in its .nanite-meta.json). The folder's
// handle (from the browser's folder picker) is kept per root in IndexedDB; the browser asks again for permission to write it
// on later visits. The mount is also held in the machine's memory: it is for one's files, not for big downloads.
export const FOLDER_PATH = "/root/disk";

type Handle = FileSystemDirectoryHandle & {
  queryPermission?(o: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "readwrite" }): Promise<PermissionState>;
};

/** Whether this browser has the folder picker (Chrome, Edge; not Firefox or Safari). */
export const folderSupported = (): boolean => typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

const DB = "nanite-webshell-folders", STORE = "handles";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => { const r = f(d.transaction(STORE, mode).objectStore(STORE)); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  } finally { d.close(); }
}

/** The folder chosen for a root's disk, if any. */
export const savedFolder = (disk: string): Promise<Handle | null> => tx("readonly", (s) => s.get(disk) as IDBRequest<Handle | undefined>).then((h) => h ?? null, () => null);
/** Keeps (or, with null, forgets) the folder for a root's disk. */
export const saveFolder = (disk: string, h: FileSystemDirectoryHandle | null): Promise<unknown> =>
  tx<unknown>("readwrite", (s) => (h ? s.put(h, disk) : s.delete(disk)) as IDBRequest<unknown>);

/** The browser's folder picker (needs a click). */
export const pickFolder = (): Promise<FileSystemDirectoryHandle> =>
  (globalThis as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: "nanite-disk", mode: "readwrite" });

/** Permission to write the folder: as it stands, or (ask, which needs a click) asked for. */
export async function permission(h: Handle, ask = false): Promise<PermissionState> {
  try {
    const now = (await h.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    return now === "prompt" && ask ? ((await h.requestPermission?.({ mode: "readwrite" })) ?? "denied") : now;
  } catch { return "denied"; }
}

/** Nanite's mount for the folder. */
export const folderMount = (h: FileSystemDirectoryHandle) => ({ path: FOLDER_PATH, backend: "dir", handle: h, interval: 1000 });
