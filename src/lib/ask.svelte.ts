// Asking the user, in the page's own dialog (lib/AskDialog.svelte) instead of the browser's confirm() / prompt().
export type AskOptions = {
  title: string; message?: string;
  /** The icon: a question, a warning (data is lost), or a destructive action. */
  tone?: "question" | "warn" | "danger";
  confirm?: string; cancel?: string;
  /** Ask for text: its initial value (and placeholder). */
  input?: string; placeholder?: string;
};
type Pending = AskOptions & { resolve: (v: string | null) => void };
export const asking = $state<{ current: Pending | null }>({ current: null });

function open(o: AskOptions): Promise<string | null> {
  asking.current?.resolve(null);
  return new Promise((resolve) => { asking.current = { ...o, resolve }; });
}
/** Yes or no. */
export const ask = async (o: AskOptions): Promise<boolean> => (await open(o)) !== null;
/** Some text, or null when cancelled. */
export const askText = (o: AskOptions): Promise<string | null> => open({ ...o, input: o.input ?? "" });
