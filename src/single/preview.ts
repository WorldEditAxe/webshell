// The single-file build (vite.single.config.ts) has no Web Browser tab (Scramjet needs a service worker): lib/preview.ts is this.
export const servePreviews = (..._: unknown[]): void => {};
export const proxiedUrl = async (url: string): Promise<string> => url;
export const unproxiedUrl = async (url: string): Promise<string> => url;
export const devtoolsForFrames = null;
export const currentWisp = (): string | null => null;
