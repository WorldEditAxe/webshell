# export-rootfs.py: a `docker export` tar on stdin -> the same tar without /.dockerenv and /dev, on stdout. Nanite provides /dev
# itself (null, tty, pts, fb0, input/, ...), and an image /dev loaded over it on a first visit leaves dead entries.
# Used by tools/make-root.sh and by server.mjs (rootfs from a Docker image).   docker export C | python3 -I tools/export-rootfs.py
import sys, tarfile
src = tarfile.open(fileobj=sys.stdin.buffer, mode="r|")
dst = tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.GNU_FORMAT)
for m in src:
    n = m.name.removeprefix("./").removeprefix("/")
    if n == ".dockerenv" or n == "dev" or n.startswith("dev/"): continue
    dst.addfile(m, src.extractfile(m) if m.isreg() else None)
dst.close()
