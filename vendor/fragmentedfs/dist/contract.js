// SPDX-License-Identifier: MIT
//
// The filesystem contract FragmentedFS implements. It is the `FS` interface of
// browser-linux's virtio-fs and virtio-9p devices (`package/src/virtio/fs.ts`
// there), restated here so that this library stands alone: the kernel package
// depends on FragmentedFS, never the other way round. The two are structurally
// the same types, and the kernel's devices recognize `FSError` by its name and
// `errno`, not by class, so an error thrown from here reaches the guest as the
// errno it carries.
const Errno = {
    EPERM: 1,
    ENOENT: 2,
    EIO: 5,
    ENXIO: 6,
    EBADF: 9,
    EAGAIN: 11,
    ENOMEM: 12,
    EACCES: 13,
    EBUSY: 16,
    EEXIST: 17,
    EXDEV: 18,
    ENOTDIR: 20,
    EISDIR: 21,
    EINVAL: 22,
    ETXTBSY: 26,
    EFBIG: 27,
    ENOSPC: 28,
    ESPIPE: 29,
    EROFS: 30,
    EMLINK: 31,
    ERANGE: 34,
    EPROTO: 71,
    ENAMETOOLONG: 36,
    ENOSYS: 38,
    ENOTEMPTY: 39,
    ELOOP: 40,
    ENODATA: 61,
    EOVERFLOW: 75,
    EOPNOTSUPP: 95,
    ESTALE: 116,
    EDQUOT: 122,
};
/** An expected filesystem failure which should be returned to the guest. */
export class FSError extends Error {
    errno;
    constructor(code, message = code) {
        super(message);
        this.name = "FSError";
        this.errno = Errno[code];
    }
}
/**
 * The errno of an expected filesystem failure, from any implementation of this
 * contract: an `FSError` of this library, or of another copy of the class (a
 * backend written against browser-linux's own has its own), recognized by its
 * name and a whole-number `errno`. `undefined` for anything else.
 */
export function errnoOf(error) {
    if (error instanceof Error && error.name === "FSError") {
        const errno = error.errno;
        if (typeof errno === "number" && Number.isInteger(errno) && errno > 0)
            return errno;
    }
    return undefined;
}
