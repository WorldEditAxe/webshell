export interface Hasher {
    update(data: Uint8Array): Hasher;
    /** An independent hasher in the same state, so a running hash can be read without ending it. */
    copy(): Hasher;
    digest(): Uint8Array;
    digestHex(): string;
}
export declare function toHex(bytes: Uint8Array): string;
/** The pure JavaScript hasher; also what the tests check Node's against. */
export declare class Sha256 implements Hasher {
    #private;
    update(data: Uint8Array): this;
    copy(): Sha256;
    digest(): Uint8Array;
    digestHex(): string;
}
/** A new incremental hasher: Node's native one when there is one, otherwise `Sha256`. */
export declare function createHasher(): Hasher;
/** The lowercase hex SHA-256 of `data`. */
export declare function sha256Hex(data: Uint8Array): Promise<string>;
/** A zero-filled chunk, shared by the code that hashes sparse regions. */
export declare const ZEROS: Uint8Array<ArrayBuffer>;
/** Feeds `length` zero bytes into a hasher. */
export declare function updateZeros(hasher: Hasher, length: number): void;
/** The SHA-256 of nothing, the hash of every empty file. */
export declare const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** `byteLength` random bytes as lowercase hex, the name of a blob. */
export declare function randomHex(byteLength: number): string;
