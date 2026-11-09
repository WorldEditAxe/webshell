/* usage.c — minimal CPU / RAM / disk / network usage report (Linux).
 * Portable C99 + POSIX, no dependencies (glibc, musl, uClibc; gcc, clang, tcc).
 *   cc -O2 -o usage usage.c
 * Colours are always on; set NO_COLOR=1 to turn them off. */
#define _DEFAULT_SOURCE
#include <dirent.h>
#include <mntent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/statvfs.h>
#include <time.h>
#include <unistd.h>

static const char *B = "", *D = "", *R = "", *G = "", *Y = "", *E = "",
                  *C = "", *M = "", *BL = "", *O = "", *W = "";

static void bar(int p, const char *icon, const char *label, const char *lc, const char *detail) {
    static int first = 1;
    const int w = 40;
    const char *c = p >= 85 ? E : p >= 60 ? Y : G;
    int i, n;
    if (p < 0) p = 0;
    if (p > 100) p = 100;
    n = p * w / 100;
    if (!first) putchar('\n');
    first = 0;
    printf("%s %s%s%s%s  %s\n   %s", icon, B, lc, label, R, detail, c);
    for (i = 0; i < w; i++) {
        if (i == n) printf("%s%s", R, D);
        fputs(i < n ? "█" : "░", stdout);
    }
    printf("%s %s%s%3d%%%s\n", R, c, B, p, R);
}

/* human-readable bytes into buf */
static const char *hb(char *buf, size_t len, double b) {
    static const char u[] = "BKMGTP";
    int i = 0;
    while (b >= 1024 && i < 5) { b /= 1024; i++; }
    snprintf(buf, len, i ? "%.1f%c" : "%.0f%c", b, u[i]);
    return buf;
}

/* first line of /proc/stat: busy and total jiffies */
static void cpu_read(unsigned long long *busy, unsigned long long *total) {
    unsigned long long v[8] = {0};
    FILE *f = fopen("/proc/stat", "r");
    int i;
    *busy = *total = 0;
    if (!f) return;
    if (fscanf(f, "cpu %llu %llu %llu %llu %llu %llu %llu %llu",
               &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6], &v[7]) >= 4) {
        for (i = 0; i < 8; i++) *total += v[i];
        *busy = *total - v[3] - v[4];               /* minus idle + iowait */
    }
    fclose(f);
}

/* rx/tx byte counters of interface ifc from /proc/net/dev */
static int net_read(const char *ifc, unsigned long long *rx, unsigned long long *tx) {
    char line[512], name[64];
    unsigned long long v[9];
    int found = 0;
    FILE *f = fopen("/proc/net/dev", "r");
    if (!f) return 0;
    while (!found && fgets(line, sizeof line, f)) {
        char *colon = strchr(line, ':'), *s = line;
        if (!colon) continue;
        *colon = ' ';
        if (sscanf(s, "%63s %llu %llu %llu %llu %llu %llu %llu %llu %llu", name,
                   &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6], &v[7], &v[8]) == 10 &&
            strcmp(name, ifc) == 0) {
            *rx = v[0]; *tx = v[8]; found = 1;
        }
    }
    fclose(f);
    return found;
}

static long long meminfo(const char *key) {
    char line[256];
    size_t k = strlen(key);
    long long v = -1;
    FILE *f = fopen("/proc/meminfo", "r");
    if (!f) return -1;
    while (fgets(line, sizeof line, f))
        if (strncmp(line, key, k) == 0 && line[k] == ':') { v = atoll(line + k + 1); break; }
    fclose(f);
    return v;
}

static int skip_mount(const struct mntent *m) {
    static const char *fs[] = {"tmpfs", "devtmpfs", "overlay", "squashfs", "proc", "sysfs",
        "cgroup", "cgroup2", "devpts", "mqueue", "debugfs", "tracefs", "securityfs", "pstore",
        "bpf", "configfs", "fusectl", "hugetlbfs", "autofs", "efivarfs", "binfmt_misc",
        "ramfs", "nsfs", "rpc_pipefs", "fuse.gvfsd-fuse", "fuse.portal", NULL};
    static const char *dirs[] = {"/proc", "/sys", "/dev", "/run", "/snap", NULL};
    int i;
    for (i = 0; fs[i]; i++) if (strcmp(m->mnt_type, fs[i]) == 0) return 1;
    for (i = 0; dirs[i]; i++) {
        size_t n = strlen(dirs[i]);
        if (strncmp(m->mnt_dir, dirs[i], n) == 0 && (m->mnt_dir[n] == '/' || !m->mnt_dir[n])) return 1;
    }
    return 0;
}

static int disk(const char *dir) {
    struct statvfs s;
    char a[16], b[16], d[256];
    double fr, used, size, avail;
    if (statvfs(dir, &s) != 0 || s.f_blocks == 0) return 0;
    fr = s.f_frsize ? s.f_frsize : s.f_bsize;
    size = s.f_blocks * fr;
    used = (s.f_blocks - s.f_bfree) * fr;
    avail = s.f_bavail * fr;
    snprintf(d, sizeof d, "%s%s%s %s/%s %s%s%s  %s%s%s", W, hb(a, sizeof a, used), R, D, R,
             W, hb(b, sizeof b, size), R, BL, dir, R);
    /* percentage like df: used / (used + avail), rounded up */
    bar(used + avail > 0 ? (int)((100 * used + used + avail - 1) / (used + avail)) : 0,
        "💾", "Disk", BL, d);
    return 1;
}

int main(void) {
    char nif[64] = "", buf[512], a[16], b[16], t[48];
    unsigned long long b1, t1, b2, t2, rx1 = 0, tx1 = 0, rx2 = 0, tx2 = 0;
    struct timespec half = {0, 500000000L};
    double up = 0, l1 = 0, l5 = 0, l15 = 0;
    int running = 0, procs = 0, cpu, have_net, shown = 0;
    long long mt, ma;
    FILE *f;
    DIR *dp;
    struct dirent *de;

    if (!getenv("NO_COLOR")) {
        B = "\033[1m"; D = "\033[2m"; R = "\033[0m"; G = "\033[32m"; Y = "\033[33m";
        E = "\033[31m"; C = "\033[96m"; M = "\033[95m"; BL = "\033[94m"; O = "\033[93m";
        W = "\033[97m";
    }

    /* default-route interface */
    if ((f = fopen("/proc/net/route", "r"))) {
        char ifc[64], dst[16];
        while (fgets(buf, sizeof buf, f))
            if (sscanf(buf, "%63s %15s", ifc, dst) == 2 && strcmp(dst, "00000000") == 0) {
                strcpy(nif, ifc);
                break;
            }
        fclose(f);
    }

    /* CPU + network: two samples 0.5 s apart */
    cpu_read(&b1, &t1);
    have_net = nif[0] && net_read(nif, &rx1, &tx1);
    nanosleep(&half, NULL);
    cpu_read(&b2, &t2);
    if (have_net) net_read(nif, &rx2, &tx2);
    cpu = t2 > t1 ? (int)(100 * (b2 - b1) / (t2 - t1)) : 0;

    if ((f = fopen("/proc/uptime", "r"))) { if (fscanf(f, "%lf", &up) != 1) up = 0; fclose(f); }
    if ((f = fopen("/proc/loadavg", "r"))) {
        if (fscanf(f, "%lf %lf %lf %d", &l1, &l5, &l15, &running) != 4) running = 0;
        fclose(f);
    }
    if ((dp = opendir("/proc"))) {
        while ((de = readdir(dp)))
            if (de->d_name[0] >= '0' && de->d_name[0] <= '9') procs++;
        closedir(dp);
    }

    /* header */
    {
        long s = (long)up, d = s / 86400;
        if (d) snprintf(t, sizeof t, "%ldd %ldh %ldm", d, s % 86400 / 3600, s % 3600 / 60);
        else snprintf(t, sizeof t, "%ldh %ldm", s / 3600, s % 3600 / 60);
        printf("%s%sSystem Stats%s %s(up%s %s%s%s%s)%s\n", B, C, R, D, R, W, t, R, D, R);
    }

    snprintf(buf, sizeof buf,
             "%sload%s %s%.2f %.2f %.2f%s %s·%s %s%ld%s %scores ·%s %s%d%s %sprocs (%s%s%d%s %srunning)%s",
             D, R, W, l1, l5, l15, R, D, R, W, sysconf(_SC_NPROCESSORS_ONLN), R, D, R,
             W, procs, R, D, R, W, running, R, D, R);
    bar(cpu, "⚡", "CPU", C, buf);

    mt = meminfo("MemTotal");
    ma = meminfo("MemAvailable");
    if (ma < 0) ma = meminfo("MemFree") + meminfo("Buffers") + meminfo("Cached");
    if (mt > 0) {
        snprintf(buf, sizeof buf, "%s%lld%s %s/%s %s%lld%s %sMiB%s",
                 W, (mt - ma) / 1024, R, D, R, W, mt / 1024, R, D, R);
        bar((int)(100 * (mt - ma) / mt), "🧠", "RAM", M, buf);
    }

    /* disks: real filesystems, one per device; fall back to / */
    if ((f = setmntent("/proc/mounts", "r"))) {
        char seen[64][256];
        int nseen = 0, i, dup;
        struct mntent *m;
        while ((m = getmntent(f))) {
            if (skip_mount(m)) continue;
            for (dup = 0, i = 0; i < nseen; i++) if (strcmp(seen[i], m->mnt_fsname) == 0) dup = 1;
            if (dup) continue;
            if (disk(m->mnt_dir)) {
                shown++;
                if (nseen < 64) snprintf(seen[nseen++], sizeof seen[0], "%s", m->mnt_fsname);
            }
        }
        endmntent(f);
    }
    if (!shown) disk("/");

    if (have_net) {
        unsigned long long rx = (rx2 - rx1) * 2, tx = (tx2 - tx1) * 2;    /* bytes/s */
        long speed = 0;
        char sp[48] = "", tot[16];
        snprintf(buf, sizeof buf, "/sys/class/net/%s/speed", nif);
        if ((f = fopen(buf, "r"))) { if (fscanf(f, "%ld", &speed) != 1) speed = 0; fclose(f); }
        if (speed > 0) snprintf(sp, sizeof sp, " %s@ %ldMb/s%s", D, speed, R);
        snprintf(buf, sizeof buf, "%s↓%s %s%s/s%s %s↑%s %s%s/s%s %s·%s %s%s%s %sout total%s  %s%s%s%s",
                 G, R, W, hb(a, sizeof a, rx), R, M, R, W, hb(b, sizeof b, tx), R,
                 D, R, W, hb(tot, sizeof tot, tx2), R, D, R, O, nif, R, sp);
        bar(speed > 0 ? (int)((rx > tx ? rx : tx) * 8 / (speed * 10000ULL)) : 0, "🌐", "Net", O, buf);
    }
    return 0;
}
