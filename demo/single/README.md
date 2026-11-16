# The single-file build's extras (tools/build-single.mjs)

Added to its root, Alpine's minirootfs:

- `home/`: scripts in root's home directory. `install-desktop.sh` sets up XFCE on the Display tab (Xorg, with a stub package
  in place of Mesa and LLVM); `install-ssh.sh` installs the OpenSSH client and makes a key (`server`: sshd too).
- `rootfs/usr/local/bin/nanite-xkeys`: the desktop's keyboard (`demo/rootfs/usr/local/src/nanite-xkeys`), built for Alpine's musl.
  It is kept prebuilt here because the Cloudflare build has no Docker. Rebuild it after a change to its source:

      docker run --rm --platform linux/amd64 -v "$PWD/demo/rootfs/usr/local/src/nanite-xkeys:/src:ro" \
        -v "$PWD/demo/single/rootfs/usr/local/bin:/out" alpine:3.22 sh -c 'apk add -q gcc musl-dev linux-headers \
        libx11-dev libxtst-dev && gcc -O2 -s -o /out/nanite-xkeys /src/nanite-xkeys.c -lX11 -lXtst'
