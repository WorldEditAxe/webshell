/** Runs one function at a time, in the order they were asked for. */
export declare class Mutex {
    #private;
    run<T>(fn: () => Promise<T> | T): Promise<T>;
}
/** Many readers or one writer; waiters are served in order so neither starves. */
export declare class RWLock {
    #private;
    read<T>(fn: () => Promise<T> | T): Promise<T>;
    write<T>(fn: () => Promise<T> | T): Promise<T>;
    get idle(): boolean;
}
/**
 * Verified fragments by blob id, oldest dropped first once the byte budget is
 * exceeded. Concurrent requests for one id share one load.
 */
/**
 * A blob as it arrives: readers wait for the bytes they want, not for the rest. `bytes` is the blob's full size from the start;
 * only what `until` has promised is there yet, and it has not been checked until the whole blob has.
 */
export declare class StreamingBlob {
    #private;
    readonly bytes: Uint8Array;
    filled: number;
    constructor(size: number);
    /** Returns false when the chunk would not fit: the blob is longer than it should be. */
    add(chunk: Uint8Array): boolean;
    fail(error: unknown): void;
    until(end: number): Promise<void>;
}
export declare class FragmentCache {
    #private;
    readonly capacity: number;
    constructor(capacity: number);
    get bytes(): number;
    get(id: string, load: () => Promise<Uint8Array>): Promise<Uint8Array>;
    /** The blob if it is held, without waiting for or starting anything. */
    peek(id: string): Uint8Array | undefined;
    /** Starts loading `id` for a later `get`; a failure surfaces then, not here. */
    prefetch(id: string, load: () => Promise<Uint8Array>): void;
    set(id: string, data: Uint8Array): void;
    delete(id: string): void;
    clear(): void;
}
/** Runs `fn` over `items` with at most `limit` in flight; rejects with the first failure. */
export declare function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void>;
