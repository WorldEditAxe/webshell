/* hello.c: a freestanding Linux program (no libc, raw system calls) for six architectures. Nanite runs every one of them.
   It prints the architecture it was built for and what uname(2) reports. Build: tools/build-hello.sh */
typedef unsigned long ul;
#if defined(__x86_64__)
#define ARCH "x86-64"
#define NR_WRITE 1
#define NR_UNAME 63
#define NR_EXIT 231
static long sys3(long n, long a, long b, long c) { long r; __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory"); return r; }
#elif defined(__i386__)
#define ARCH "x86 (i386)"
#define NR_WRITE 4
#define NR_UNAME 122
#define NR_EXIT 252
static long sys3(long n, long a, long b, long c) { long r; __asm__ volatile("int $0x80" : "=a"(r) : "a"(n), "b"(a), "c"(b), "d"(c) : "memory"); return r; }
#elif defined(__aarch64__)
#define ARCH "arm64 (aarch64)"
#define NR_WRITE 64
#define NR_UNAME 160
#define NR_EXIT 94
static long sys3(long n, long a, long b, long c) { register long x8 __asm__("x8") = n, x0 __asm__("x0") = a, x1 __asm__("x1") = b, x2 __asm__("x2") = c;
  __asm__ volatile("svc 0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2) : "memory"); return x0; }
#elif defined(__arm__)
#define ARCH "armhf (armv7)"
#define NR_WRITE 4
#define NR_UNAME 122
#define NR_EXIT 248
static long sys3(long n, long a, long b, long c) { register long r7 __asm__("r7") = n, r0 __asm__("r0") = a, r1 __asm__("r1") = b, r2 __asm__("r2") = c;
  __asm__ volatile("svc 0" : "+r"(r0) : "r"(r7), "r"(r1), "r"(r2) : "memory"); return r0; }
#elif defined(__riscv)
#if __riscv_xlen == 64
#define ARCH "riscv64"
#else
#define ARCH "riscv32"
#endif
#define NR_WRITE 64
#define NR_UNAME 160
#define NR_EXIT 94
static long sys3(long n, long a, long b, long c) { register long a7 __asm__("a7") = n, a0 __asm__("a0") = a, a1 __asm__("a1") = b, a2 __asm__("a2") = c;
  __asm__ volatile("ecall" : "+r"(a0) : "r"(a7), "r"(a1), "r"(a2) : "memory"); return a0; }
#endif

struct utsname { char sysname[65], nodename[65], release[65], version[65], machine[65], domainname[65]; };
static ul len(const char *s) { ul n = 0; while (s[n]) n++; return n; }
static void put(const char *s) { sys3(NR_WRITE, 1, (long)s, (long)len(s)); }

void main_c(void) {
  static struct utsname u;
  put("\033[1;35mhello\033[0m from a \033[1;36m" ARCH "\033[0m binary");
  if (sys3(NR_UNAME, (long)&u, 0, 0) == 0) { put(" \033[2m(uname -m says "); put(u.machine); put(")\033[0m"); }
  put("\n");
  sys3(NR_EXIT, 0, 0, 0);
  for (;;) {}
}
/* Entry: align the stack and call main_c. */
#if defined(__x86_64__)
__asm__(".globl _start\n_start:\n andq $-16, %rsp\n call main_c\n");
#elif defined(__i386__)
__asm__(".globl _start\n_start:\n andl $-16, %esp\n call main_c\n");
#elif defined(__aarch64__)
__asm__(".globl _start\n_start:\n bl main_c\n");
#elif defined(__arm__)
__asm__(".globl _start\n_start:\n bl main_c\n");
#elif defined(__riscv)
__asm__(".globl _start\n_start:\n .option push\n .option norelax\n la gp, __global_pointer$\n .option pop\n call main_c\n");
#endif
