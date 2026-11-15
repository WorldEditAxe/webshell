// The single-file build (vite.single.config.ts) has no VS Code, so no guest file server: lib/files.ts is this.
export const FSD = "";
export class GuestFiles {
  constructor(_: unknown) {}
  ready(): Promise<void> { return Promise.reject(new Error("no VS Code in the single-file build")); }
}
