// SPDX-License-Identifier: MIT
//
// The small concurrency tools FragmentedFS is built from: an exclusive lock, a
// reader/writer lock, a least-recently-used cache of fragments and a bounded
// parallel loop.
/** Runs one function at a time, in the order they were asked for. */
export class Mutex {
    #tail = Promise.resolve();
    run(fn) {
        const result = this.#tail.then(fn, fn);
        this.#tail = result.catch(() => { });
        return result;
    }
}
/** Many readers or one writer; waiters are served in order so neither starves. */
export class RWLock {
    #readers = 0;
    #writing = false;
    #queue = [];
    read(fn) {
        return this.#run(false, fn);
    }
    write(fn) {
        return this.#run(true, fn);
    }
    get idle() {
        return this.#readers === 0 && !this.#writing && this.#queue.length === 0;
    }
    async #run(write, fn) {
        await new Promise((grant) => {
            this.#queue.push({ write, grant });
            this.#pump();
        });
        try {
            return await fn();
        }
        finally {
            if (write)
                this.#writing = false;
            else
                this.#readers -= 1;
            this.#pump();
        }
    }
    #pump() {
        for (;;) {
            const next = this.#queue[0];
            if (!next)
                return;
            if (next.write) {
                if (this.#readers > 0 || this.#writing)
                    return;
                this.#writing = true;
            }
            else {
                if (this.#writing)
                    return;
                this.#readers += 1;
            }
            this.#queue.shift();
            next.grant();
        }
    }
}
/**
 * Verified fragments by blob id, oldest dropped first once the byte budget is
 * exceeded. Concurrent requests for one id share one load.
 */
/**
 * A blob as it arrives: readers wait for the bytes they want, not for the rest. `bytes` is the blob's full size from the start;
 * only what `until` has promised is there yet, and it has not been checked until the whole blob has.
 */
export class StreamingBlob {
    bytes;
    filled = 0;
    #failure;
    #waiting = [];
    constructor(size) {
        this.bytes = new Uint8Array(size);
    }
    /** Returns false when the chunk would not fit: the blob is longer than it should be. */
    add(chunk) {
        if (this.filled + chunk.byteLength > this.bytes.byteLength)
            return false;
        this.bytes.set(chunk, this.filled);
        this.filled += chunk.byteLength;
        this.#waiting = this.#waiting.filter((waiter) => {
            if (waiter.end > this.filled)
                return true;
            waiter.resolve();
            return false;
        });
        return true;
    }
    fail(error) {
        this.#failure = { error };
        for (const waiter of this.#waiting)
            waiter.reject(error);
        this.#waiting = [];
    }
    until(end) {
        if (this.#failure)
            return Promise.reject(this.#failure.error);
        if (end <= this.filled)
            return Promise.resolve();
        return new Promise((resolve, reject) => this.#waiting.push({ end, resolve, reject }));
    }
}
export class FragmentCache {
    capacity;
    #entries = new Map();
    #loading = new Map();
    #bytes = 0;
    constructor(capacity) {
        this.capacity = capacity;
    }
    get bytes() {
        return this.#bytes;
    }
    async get(id, load) {
        const hit = this.#entries.get(id);
        if (hit) {
            this.#entries.delete(id);
            this.#entries.set(id, hit);
            return hit;
        }
        let pending = this.#loading.get(id);
        if (!pending) {
            pending = load().then((data) => {
                this.set(id, data);
                return data;
            });
            this.#loading.set(id, pending);
            const forget = () => {
                if (this.#loading.get(id) === pending)
                    this.#loading.delete(id);
            };
            pending.then(forget, forget);
        }
        return pending;
    }
    /** The blob if it is held, without waiting for or starting anything. */
    peek(id) {
        return this.#entries.get(id);
    }
    /** Starts loading `id` for a later `get`; a failure surfaces then, not here. */
    prefetch(id, load) {
        if (this.#entries.has(id) || this.#loading.has(id))
            return;
        this.get(id, load).catch(() => { });
    }
    set(id, data) {
        const old = this.#entries.get(id);
        if (old) {
            this.#bytes -= old.byteLength;
            this.#entries.delete(id);
        }
        if (data.byteLength > this.capacity)
            return;
        this.#entries.set(id, data);
        this.#bytes += data.byteLength;
        for (const [key, value] of this.#entries) {
            if (this.#bytes <= this.capacity)
                break;
            this.#entries.delete(key);
            this.#bytes -= value.byteLength;
        }
    }
    delete(id) {
        const old = this.#entries.get(id);
        if (!old)
            return;
        this.#entries.delete(id);
        this.#bytes -= old.byteLength;
    }
    clear() {
        this.#entries.clear();
        this.#bytes = 0;
    }
}
/** Runs `fn` over `items` with at most `limit` in flight; rejects with the first failure. */
export async function forEachLimit(items, limit, fn) {
    let next = 0;
    let failed = false;
    const worker = async () => {
        while (!failed && next < items.length) {
            const index = next++;
            try {
                await fn(items[index], index);
            }
            catch (error) {
                failed = true;
                throw error;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
