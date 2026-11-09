// paint: draw on the virtual screen (/dev/fb0) with the mouse (/dev/input/event1) and keyboard (/dev/input/event0).
// Freestanding x86-64 Linux: raw system calls, no libc. Build: tools/build-hello.sh
//
//   mouse      move: cursor   left button: paint   right button: erase
//   keyboard   1-8: colour    arrows: move   space: paint   c: clear   q / Esc: quit
//   click a swatch in the top bar to pick its colour.

typedef unsigned long u64; typedef long i64; typedef unsigned u32; typedef int i32; typedef unsigned short u16; typedef short i16;

static i64 sys(i64 n, i64 a, i64 b, i64 c, i64 d) {
  i64 r; register i64 r10 __asm__("r10") = d;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10) : "rcx", "r11", "memory");
  return r;
}
enum { SYS_read = 0, SYS_write = 1, SYS_poll = 7, SYS_ioctl = 16, SYS_pwrite64 = 18, SYS_nanosleep = 35, SYS_exit_group = 231, SYS_openat = 257 };
enum { AT_FDCWD = -100, O_RDONLY = 0, O_RDWR = 2, O_NONBLOCK = 04000, FBIOGET_VSCREENINFO = 0x4600 };
enum { EV_KEY = 1, EV_REL = 2, REL_X = 0, REL_Y = 1, BTN_LEFT = 272, BTN_RIGHT = 273,
       KEY_ESC = 1, KEY_1 = 2, KEY_8 = 9, KEY_Q = 16, KEY_C = 46, KEY_SPACE = 57, KEY_UP = 103, KEY_LEFT = 105, KEY_RIGHT = 106, KEY_DOWN = 108 };

// The compiler may turn loops into these calls even without libc.
void *memset(void *d, int c, u64 n) { unsigned char *p = d; while (n--) *p++ = (unsigned char)c; return d; }
void *memcpy(void *d, const void *s, u64 n) { unsigned char *p = d; const unsigned char *q = s; while (n--) *p++ = *q++; return d; }

static u64 len(const char *s) { u64 n = 0; while (s[n]) n++; return n; }
static void say(const char *s) { sys(SYS_write, 1, (i64)s, len(s), 0); }
static void die(const char *s) { say(s); sys(SYS_exit_group, 1, 0, 0, 0); }

#define WMAX 1920
#define HMAX 1200
#define BAR 36
static u32 canvas[WMAX * HMAX];   // what is painted (0x00RRGGBB, the framebuffer's BGRX in little-endian)
static u32 block[WMAX * 64];      // rows on their way to the framebuffer, with the cursor drawn in
static i32 W, H, cx, cy, colour = 1, painting, erasing, dirty0, dirty1, quit;
static const u32 PALETTE[9] = { 0, 0xff65fd, 0xcbb6ff, 0x22e529, 0xf59574, 0x9892f1, 0xf41d99, 0xeeeeee, 0x41af1a };
#define PAPER 0x0b0910

static void touch(i32 y0, i32 y1) {
  if (y0 < 0) y0 = 0; if (y1 >= H) y1 = H - 1; if (y0 > y1) return;
  if (dirty0 > dirty1) { dirty0 = y0; dirty1 = y1; return; }
  if (y0 < dirty0) dirty0 = y0; if (y1 > dirty1) dirty1 = y1;
}
static void bar(void) {
  for (i32 y = 0; y < BAR; y++) for (i32 x = 0; x < W; x++) {
    i32 slot = x / 44 + 1; u32 c = 0x1a1222;
    if (slot <= 8 && x % 44 >= 6 && y >= 6 && y < BAR - 6) c = PALETTE[slot];
    if (slot == colour && x % 44 >= 2 && x % 44 < 42 && (y == 2 || y == BAR - 3)) c = 0xffffff;
    canvas[y * W + x] = c;
  }
  touch(0, BAR - 1);
}
static void clear(void) {
  for (i32 y = BAR; y < H; y++) for (i32 x = 0; x < W; x++) canvas[y * W + x] = PAPER;
  bar(); touch(0, H - 1);
}
static void dot(i32 px, i32 py, u32 c) {
  const i32 r = erasing ? 10 : 4;
  for (i32 y = py - r; y <= py + r; y++) for (i32 x = px - r; x <= px + r; x++)
    if (x >= 0 && x < W && y >= BAR && y < H && (x - px) * (x - px) + (y - py) * (y - py) <= r * r) canvas[y * W + x] = c;
  touch(py - r, py + r);
}
static void stroke(i32 x0, i32 y0, i32 x1, i32 y1) {
  u32 c = erasing ? PAPER : PALETTE[colour];
  i32 dx = x1 - x0, dy = y1 - y0, n = (dx < 0 ? -dx : dx) > (dy < 0 ? -dy : dy) ? (dx < 0 ? -dx : dx) : (dy < 0 ? -dy : dy);
  if (n == 0) { dot(x1, y1, c); return; }
  for (i32 i = 0; i <= n; i += 2) dot(x0 + dx * i / n, y0 + dy * i / n, c);
  dot(x1, y1, c);
}
static void move(i32 nx, i32 ny) {
  if (nx < 0) nx = 0; if (nx >= W) nx = W - 1; if (ny < 0) ny = 0; if (ny >= H) ny = H - 1;
  touch(cy - 12, cy + 12);
  if (painting || erasing) stroke(cx, cy, nx, ny);
  cx = nx; cy = ny; touch(cy - 12, cy + 12);
}
static void press(i32 down) {
  if (down && cy < BAR) { i32 slot = cx / 44 + 1; if (slot <= 8) { colour = slot; bar(); } return; }
  painting = down; if (down) stroke(cx, cy, cx, cy);
}
static u32 cursor_px(i32 x, i32 y) {   // a crosshair: white with a dark outline
  i32 ax = x - cx, ay = y - cy; if (ax < 0) ax = -ax; if (ay < 0) ay = -ay;
  if ((ax <= 1 && ay <= 10 && ay >= 3) || (ay <= 1 && ax <= 10 && ax >= 3)) return (ax == 1 || ay == 1) ? 0x000000 : 0xffffff;
  if (ax <= 1 && ay <= 1) return PALETTE[colour] | (colour == 0);
  return 0xffffffffu;
}
static void flush(i32 fb) {
  if (dirty0 > dirty1) return;
  for (i32 y0 = dirty0; y0 <= dirty1; y0 += 64) {
    i32 rows = dirty1 - y0 + 1; if (rows > 64) rows = 64;
    for (i32 r = 0; r < rows; r++) {
      i32 y = y0 + r; u32 *src = canvas + y * W, *dst = block + r * W;
      for (i32 x = 0; x < W; x++) dst[x] = src[x];
      if (y >= cy - 10 && y <= cy + 10) for (i32 x = cx - 10; x <= cx + 10; x++) if (x >= 0 && x < W) { u32 c = cursor_px(x, y); if (c != 0xffffffffu) dst[x] = c; }
    }
    sys(SYS_pwrite64, fb, (i64)block, (i64)rows * W * 4, (i64)y0 * W * 4);
  }
  dirty0 = 1; dirty1 = 0;
}

struct input_event { i64 sec, usec; u16 type, code; i32 value; };
// Motion is added up and drawn as one segment per report (EV_SYN, or the end of a read): moving by REL_X and then REL_Y
// separately would draw every diagonal as an L, a staircase along fast strokes.
static i32 mdx, mdy;
static void motion(void) { if (mdx || mdy) { move(cx + mdx, cy + mdy); mdx = mdy = 0; } }
static void handle(struct input_event *e) {
  if (e->type == EV_REL && e->code == REL_X) mdx += e->value;
  else if (e->type == EV_REL && e->code == REL_Y) mdy += e->value;
  else if (e->type == 0) motion();   // EV_SYN: the end of one report
  else if (e->type == EV_KEY && e->code == BTN_LEFT) { motion(); press(e->value != 0); }
  else if (e->type == EV_KEY && e->code == BTN_RIGHT) { erasing = e->value != 0; if (erasing) stroke(cx, cy, cx, cy); }
  else if (e->type == EV_KEY && e->value != 0) {   // key down or repeat
    i32 k = e->code, step = 12;
    if (k >= KEY_1 && k <= KEY_8) { colour = k - KEY_1 + 1; bar(); touch(cy - 12, cy + 12); }
    else if (k == KEY_C) clear();
    else if (k == KEY_Q || k == KEY_ESC) quit = 1;
    else if (k == KEY_UP) move(cx, cy - step); else if (k == KEY_DOWN) move(cx, cy + step);
    else if (k == KEY_LEFT) move(cx - step, cy); else if (k == KEY_RIGHT) move(cx + step, cy);
    else if (k == KEY_SPACE) { painting = 1; stroke(cx, cy, cx, cy); }
  } else if (e->type == EV_KEY && e->value == 0 && e->code == KEY_SPACE) painting = 0;
}

void _start(void) {
  i32 fb = sys(SYS_openat, AT_FDCWD, (i64)"/dev/fb0", O_RDWR, 0);
  if (fb < 0) die("paint: no /dev/fb0\n");
  u32 var[40] = { 0 };
  if (sys(SYS_ioctl, fb, FBIOGET_VSCREENINFO, (i64)var, 0) < 0) die("paint: FBIOGET_VSCREENINFO failed\n");
  W = var[0]; H = var[1]; if (W > WMAX) W = WMAX; if (H > HMAX) H = HMAX;
  i32 kb = sys(SYS_openat, AT_FDCWD, (i64)"/dev/input/event0", O_RDONLY | O_NONBLOCK, 0);
  i32 ms = sys(SYS_openat, AT_FDCWD, (i64)"/dev/input/event1", O_RDONLY | O_NONBLOCK, 0);
  if (kb < 0 || ms < 0) die("paint: no /dev/input/event0 or event1\n");
  say("paint: draw on the monitor tab (click it to capture mouse + keyboard, Esc releases)\n"
      "  left: paint  right: erase  1-8: colour  arrows/space: keyboard drawing  c: clear  q: quit\n");
  cx = W / 2; cy = H / 2; dirty0 = 1; dirty1 = 0; clear(); flush(fb);
  struct { i32 fd; i16 events, revents; } pfd[2] = { { kb, 1, 0 }, { ms, 1, 0 } };
  struct input_event ev[64];
  while (!quit) {
    i64 p = sys(SYS_poll, (i64)pfd, 2, 100, 0);
    if (p < 0) { i64 ts[2] = { 0, 16000000 }; sys(SYS_nanosleep, (i64)ts, 0, 0, 0); }
    for (i32 i = 0; i < 2; i++) for (;;) {
      i64 n = sys(SYS_read, pfd[i].fd, (i64)ev, sizeof ev, 0);
      if (n <= 0) break;
      for (i64 j = 0; j < n / (i64)sizeof ev[0]; j++) handle(&ev[j]);
      motion();
    }
    flush(fb);
  }
  for (i32 i = 0; i < W * H; i++) canvas[i] = 0; touch(0, H - 1); cx = cy = -100; flush(fb);
  say("paint: bye\n");
  sys(SYS_exit_group, 0, 0, 0, 0);
}
