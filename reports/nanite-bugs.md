# Nanite: `memoryLimit` charges ~53 MiB per process, so fork fails (EAGAIN) far below real memory use

## Summary

With `memoryLimit: 384 MiB`, `apt-get update` on Ubuntu 26.04 fails immediately with
`FATAL -> Failed to fork.` / `E: Method gpgv has died unexpectedly!`. Nothing is out of memory.
`memoryFits()` refuses the fork because every live process is charged the full grown size of its wasm memory
(40 MiB guest for every Ubuntu process, even `tail`) plus its runtime heap. That's about 53 MiB per process,
while the pages the process actually touched are 12–21 MiB. At 384 MiB the limit allows about 6 processes.
`apt-get update` needs 7 at once.

## Environment

- Nanite from `https://packages.sparkpowered.org/lib/nanitevisor/` (fetched 2026-11-07):
  - `nanite.js` `0aeee22da0b2946605df68a1953e33526368c0cb59c4f3581469fa0cf05c91bb`
  - `nanite.wasm` `3b2da73486ef3f704a8713113a3d918211d5245fa5371d7810c36ec9968a184a`
  - `vkernel.wasm` `4a88b9b4021b2580f7f48b165d92b507e8c34fe95832b947ace643092cc5d7d7`
- Chrome for Testing 153.0.8010.12 (headless), Linux x86-64.
- Guest: Ubuntu 26.04 LTS x86-64 rootfs (`docker export` of `ubuntu:26.04` + GNU coreutils), loaded with
  `loadTarStream` into a disk-backed root (`rootName`).
- Options: `memoryLimit: 384 * 2**20`, `processMemoryLimit: 256 * 2**20`, `tty: true`, a Wisp relay. Everything else default.

## Steps to reproduce

1. `Nanitevisor.create({ naniteUrl, vkernelUrl, rootName: "x", memoryLimit: 384 * 2**20, processMemoryLimit: 256 * 2**20, tty: true, wisp })`.
2. Load an Ubuntu 26.04 root and run `bash --login`.
3. In the shell: `apt-get update`.

## Observed

```
FATAL -> Failed to fork.
Reading package lists...
E: Method gpgv has died unexpectedly!
E: Sub-process gpgv returned an error code (100)
```

It fails within about 5 s, before any index is verified.

The same command at other limits:

| `memoryLimit` | `apt-get update` | `apt-get install -y iputils-ping` |
|---|---|---|
| 384 MiB | fails (fork EAGAIN) | fails (no lists) |
| 512 MiB | succeeds (27.1 MB fetched) | not measured |
| 1024 MiB | succeeds | succeeds |

## Measurements

`nv.memory()`, sampled every 100 ms during `apt-get update | tail -4` at 384 MiB. This is the highest sample,
just before the refused fork:

| tid | process | guest (charged) | runtime (charged) | charged total |
|---|---|---|---|---|
| 1 | bash | 40 MiB | 13 MiB | 53 MiB |
| 6 | apt-get | 40 MiB | 14 MiB | 54 MiB |
| 7 | tail | 40 MiB | 8 MiB | 48 MiB |
| 10 | http (archive.ubuntu.com) | 40 MiB | 14 MiB | 54 MiB |
| 11 | http (security.ubuntu.com) | 40 MiB | 13 MiB | 53 MiB |
| 13 | gpgv method | 40 MiB | 14 MiB | 54 MiB |
| | kernel + translation cache | | | 17 + 5 MiB |
| | **total** | | | **338 MiB** |

The gpgv method's fork of `gpgv` needs 338 + 64 (headroom) = 402 MiB ≤ 384, which fails, so `fork` returns -11.

Pages actually touched, from `nv.memory({ touched: true })` at 384 MiB:

| process | charged (guest + runtime) | resident (touched) |
|---|---|---|
| bash | 53 MiB | 12.3 MiB |
| apt-get | 48 MiB | 20.5 MiB |

In the 512 MiB run, `totals.resident` for the whole machine was 207 MB at the end of `apt-get update`.

Every Ubuntu process reports exactly `guest: 41943040` (40 MiB) whatever it does: bash, apt-get, tail, the http
methods. That looks like a starting size every process has, or keeps after fork/exec, not usage.

## Cause (from `nanite.js`)

```js
memoryInUse(e = null) {
  let t = this.vk?.memory?.buffer?.byteLength ?? 0;
  /* + sm, dwin, cache.size */
  for (let n of this.procs.values())
    n === e || !n.memory || n.sm || n.done ||
      (t += Math.max(0, n.memory.buffer.byteLength - 2**30) + ((n.x?.nanite_heap_end?.() ?? 0) >>> 0 || 0));
  return t;
}
memoryFits(e = null) { return this.memoryInUse(e) + 64 * 2**20 <= this.memoryLimit; }
fork(e, t) { /* ... */ if (!this.memoryFits()) return -11; /* ... */ }
```

Each process is charged `buffer.byteLength - 1 GiB` (its whole grown guest area) plus `nanite_heap_end()`.
It is not charged what it touched. Wasm memories never shrink, so this is an upper bound, but the gap is large:
48–53 MiB charged against 12–21 MiB touched.

## Expected

A `memoryLimit` near the machine's real memory use (384 MiB, when the machine's whole resident set during
`apt-get update` is about 200 MB) should allow ordinary multi-process work like `apt-get update`.

## Possible fixes

1. Start a process's guest area smaller than 40 MiB, or don't carry the parent's size through `exec` when the
   new image needs less (for example, a fresh memory on exec).
2. Charge touched or resident pages (`memoryReport` already computes them) instead of `byteLength`. A cheaper
   option is to charge `byteLength` only up to the guest's highest used address (brk/mmap end).
3. Make the 64 MiB fork headroom configurable, or scale it to the limit. At 384 MiB it is a sixth of the budget.

## Workaround

Use `memoryLimit` ≥ 512 MiB (`apt-get update` verified at 512; update and install verified at 1024).

---

# Nanite: exec drops empty arguments (`""`) from argv

## Summary

When a program is exec'd, Nanite decodes argv (and envp) from the NUL-separated buffer and removes every empty
string, not just the trailing terminator. Any program given `""` as an argument gets fewer arguments, and the
remaining ones shift into the wrong positions.

Same Nanite build and environment as above.

## Reproduce (bash on Ubuntu 26.04 under Nanite)

```
$ /usr/bin/printf "[%s]" "" a; echo
[a]                      # expected: [][a]
$ bash -c 'echo argc=$#' x "" "" a
argc=1                   # expected: argc=3
$ f(){ echo argc=$#; }; f "" a
argc=2                   # correct: shell functions don't go through exec
```

## Real-world effect

Every `apt-get install` ends with this, once per entry in `/etc/shells`:

```
Processing triggers for debianutils (5.23.2build1) ...
dpkg-realpath: error: need a pathname argument
```

`/usr/sbin/update-shells` line 85 runs `dpkg-realpath --root "$ROOT" "$(dirname "$line")"`, and `$ROOT` is empty
on a normal system. With the `""` dropped, `--root` takes `/bin` as its value and no pathname is left.
`/etc/shells` is not updated.

## Cause (from `nanite.js`)

Two places in the exec path (native exec, and the WASI-module exec path):

```js
let o = (t, n) => P.decode(new Uint8Array(e.memory.buffer, t, n)).split(`\0`).filter(e => e.length);
let s = o(t, n) /* argv */, c = o(r, i) /* envp */;
```

`.filter(e => e.length)` is meant to drop the final empty piece after the last NUL, but it also drops real empty
arguments.

## Fix

Remove only the trailing terminator, for example:

```js
const strs = (p, n) => { const a = P.decode(new Uint8Array(e.memory.buffer, p, n)).split("\0"); if (a.at(-1) === "") a.pop(); return a; };
```

Alternatively, pass argc / envc from the guest and split exactly that many.

---

# Nanite: device nodes (/dev/fb0, /dev/input/*, /dev/pts, /dev/snd) die after a tar load into a disk-backed root

## Summary

With `rootName` (disk-backed root) and `devices`, any `loadTar` / `loadTarStream` after `create` leaves Nanite's own
device nodes as dead directory entries. They show up in `readdir`, but `stat` and `open` return ENOENT. Nodes from
the vkernel's built-in /dev (`null`, `tty`, `ptmx`, `zero`, ...) are not affected. When the root is mounted from disk
(`rootMounted`), the devices are registered after the mount and work, until the next `loadTar`.

## Reproduce

1. `Nanitevisor.create({ ..., rootName: "fresh", devices: { fb: { width: 1024, height: 768 }, sound: false, gpu: false } })` on an empty origin.
2. `await nv.loadTarStream(ubuntuRootfs)` (an image with no `dev/` entries).
3. In the guest:

```
$ ls -la /dev
??????????  ? ?    ?       ?            ? fb0
??????????  ? ?    ?       ?            ? input
??????????  ? ?    ?       ?            ? pts
??????????  ? ?    ?       ?            ? snd
$ stat /dev/fb0
stat: cannot statx '/dev/fb0': No such file or directory
```

4. After `nv.terminate()` and a new `create` with the same `rootName`, `/dev/fb0` and `/dev/input/event0`/`event1`
   work. A further `nv.loadTar(...)` (any tar, for example two files under `root/`) kills them again.

## Effect

On a first visit a framebuffer program can't open `/dev/fb0`, and `/dev/pts` is unusable (pseudo-terminals).

## Workaround

After the first image load into a fresh disk root: `flush()`, `terminate()`, and `create()` again on the same
`rootName`. Don't call `loadTar` afterwards.

---

# Nanite: `openTerminal`: once the session leader execs, its output never reaches the page

## Summary

In a terminal from `openTerminal(argv, env)`, output works until the session leader (the terminal's first process)
calls `execve`. After that the new program runs (it sleeps in `S+`, it is the foreground process group, and it holds
`/dev/pts/N` as fds 0–2), but nothing it writes reaches `onOutput`. Children it forks are not affected. So the
usual `sh -c 'cd "$HOME" && exec bash --login'` gives a terminal that stays blank. The same command works on
the console (`run`).

## Environment

- Nanite from `https://packages.sparkpowered.org/lib/nanitevisor/` (fetched 2026-11-08), `nanite.js` sha256 `29eb4e01…`.
- Chrome for Testing 153 (headless), Linux x86-64. Ubuntu 26.04 root, disk-backed (`rootName`), `tty: true`.

## Reproduce

```js
nv.onOutput = (fd, b, t) => t !== undefined && console.log(t, new TextDecoder().decode(b));
await nv.openTerminal(["/bin/sh", "-c", "echo before; /bin/echo forked; true"]);  // "before", "forked"
await nv.openTerminal(["/bin/sh", "-c", "echo before; exec /bin/echo after-exec"]); // "before" only
await nv.openTerminal(["/bin/bash", "--login"]);                                     // a prompt
await nv.openTerminal(["/bin/bash", "-c", 'cd "$HOME" && exec /bin/bash --login']);  // nothing, ever
```

`ps -eo pid,pgid,sid,tpgid,stat,tty,comm` from another terminal shows the exec'd bash as `Ss+` on its `pts/N`,
the session leader and the foreground group, waiting.

## Also

`tty` prints `not a tty` in these terminals, although `isatty(0)` holds (`stty size` answers, bash is
interactive) and `/proc/self/fd/0` is `/dev/pts/N`. glibc's `ttyname` probably finds that `stat("/dev/pts/N")`
does not match `fstat(0)`.

## Workaround

Make the shell itself the session leader. The page starts `["/bin/bash", "--login"]` with
`PROMPT_COMMAND=cd ~; unset PROMPT_COMMAND` in the environment, so bash goes to `$HOME` before its first prompt.

---

# Nanite: interactive fish 4 exits with status 127 when it runs external commands (intermittent)

## Summary

On Nanite, an interactive fish 4.2.1 shell exits without a message, with exit status 127, when it runs external
programs. It happens most often on a pipeline of two programs (`usage | head -2`, `sleep 1 | cat`, `ls /usr | head -1`).
It also happens on a single command when that command is the second external program fish starts in the session (for
example `date` right after a login whose config ran `cat` or `mkdir`). It is intermittent: the same command kills fish
in one run and works in the next. bash 5.3, on the same machine and the same kind of terminal, runs every one of these
commands without failure. fish in `-c` mode (with or without `-i`, config or job control) does not fail either. Only
fish's interactive line editor does.

## Environment

- Nanite from `https://packages.sparkpowered.org/lib/nanitevisor/`, as tested (2026-11-08):
  - `nanite.js` `29eb4e018d8760fc9b5a6e513cc5670d64d50e36ea3b1fca27fa95b7be83dcdb`
  - Upstream has since moved to `nanite.js` `f248a10de40293e8d2ff4eab51a590b5778e55d21e80f1562c0fa849fc005b3e`,
    `nanite.wasm` `de3c280cba1be72dfeb45ffda83c3ea22fbd6ff5ad9a361a06625723c0f06bb5`, `vkernel.wasm`
    `6b8182d48288e1640ddff695f53b53e1e57fd70e31ea32f3533bb3b44c4f2e9d`. Not retested on that build.
- Chrome for Testing 153.0.8010.12 (headless), Linux x86-64.
- Guest: Ubuntu 26.04 LTS x86-64 (GNU coreutils) with Ubuntu's `fish` 4.2.1-3.2, disk-backed root (`rootName`),
  `memoryLimit` 512 MiB, `tty: true`.
- The shells run in terminals from `openTerminal` (ptys). On the console (`run`), the same thing happens: fish printed
  the motd (`cat /etc/motd` in its config) and exited 127.

## Reproduce

1. In a terminal of the machine (`openTerminal(["/bin/bash", "--login"])`), start fish from bash, so the terminal stays
   and bash reports how fish ended:
   ```
   fish --no-config; echo "fish exited: $?"
   ```
2. In fish, run one external program. It works:
   ```
   sh -c "exit 42"; echo after $status        # prints: after 42
   ```
3. Run a pipeline of two programs:
   ```
   usage | head -2                              # or: sleep 1 | cat     or: ls /usr | head -1
   ```
   fish is gone, and bash prints `fish exited: 127`. Nothing is written to the terminal. If fish survives, run another
   pipeline: `usage | head -2` killed it in every test run that got to it; the others killed it in some runs and not in
   others.

## What fish's debug log shows

`fish --no-config --debug='proc*,exec*,topic*,reader*,term*,iothread*,signal*' --debug-output=/tmp/f.log`, the last lines
before it died (here on `grep -n "H-after" /tmp/f2.log | tail -1`):

```
exec-fork: Fork #7, pid 50: spawn external command '/usr/bin/tail' from '<no file>'
exec-fork: Fork #8, pid 51: spawn external command '/usr/bin/grep' from '<no file>'
exec-job-exec: Executed job 1 from command 'command grep --color=auto $argv'
proc-job-run: Run job 1 (command grep --color=auto $argv), UNCOMPLETED, INTERACTIVE
iothread: pthread  ThreadId(32)  exiting
```

fish spawned both processes of the job (posix_spawn) and was waiting for them. The next event is one of its I/O threads
exiting, then nothing: no reaping, no error. In a run with its config, it died the same way after the first external
command of its first-run setup:

```
exec-fork: Fork #1, pid 13: spawn external command '/usr/bin/mkdir' from '<no file>'
exec-job-exec: Executed job 1 from command 'mkdir -p $__fish_config_dir/{completions, conf.d, functions}'
proc-job-run: Run job 1 (mkdir -p ...), UNCOMPLETED, NON-INTERACTIVE
```

127 is the status a spawned child exits with when it fails before `execve` (glibc's posix_spawn child, fish's own fork
path). fish itself exits 127 for no reason we can see. It looks as if a child's exit were reported as fish's.

## What works (each in its own small C program, on the same machine, terminal and build)

| test | result |
|---|---|
| `fork` + `execve`, and `posix_spawn`, with 0, 1 and 4 idle threads running, 3 rounds | all children reaped, status 0 |
| two-process job: A in a new process group, B joining A's group (`setpgid` / `POSIX_SPAWN_SETPGROUP`), `tcsetpgrp` to the group and back, with `fork` and with `posix_spawn` | works |
| pipeline `echo | tail -1` wired with `posix_spawn` file actions (`dup2` of a `pipe2(O_CLOEXEC)` pair), same process group | works, output correct |
| `posix_spawn` of a missing path, and with a failing file action (`dup2` of a closed fd) | parent gets ENOENT / EBADF and lives on |
| a thread exits (`SYS_exit`) while the main thread sleeps, or is blocked in `waitpid` on a spawned or forked child | process lives on |
| fish `-c` (no config, config, `-i`, job control none / interactive / full), with single programs and pipelines | works |
| `fish_use_posix_spawn=0` (fish forks instead) in the interactive editor | still dies, more often |

None of the pieces fails on its own, and the failure is intermittent. That points to a race inside Nanite between
process creation, waiting and signals (SIGCHLD) on one side and a process whose other threads are busy on the other
(fish's interactive editor keeps a pool of I/O threads for highlighting and autosuggestions, which start and exit while
commands run). bash, single-threaded, never hits it.

## Effect

fish is unusable as an interactive shell: it dies within the first few commands. The Nanite Webshell keeps bash as the
login shell for this reason (`tools/Dockerfile.ubuntu26`).

## Workaround

None found inside fish. Use bash (or another single-threaded shell).
