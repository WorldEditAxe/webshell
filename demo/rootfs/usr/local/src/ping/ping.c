/* ping.c: ICMP echo for the Nanite Webshell, through Spark's Wisp ping extension (0xE1, wisp.sparkpowered.org).
 * The guest has no raw network: each echo request goes as a UDP datagram to the page's bridge at the gateway, 10.0.2.2:PORT,
 * which sends it as a real ICMP echo from the Wisp server and returns the reply's payload. Round-trip times are timed here.
 *   request  "NPNG" | host length (1 byte) | IPv4 address as text | payload (the echo's data, up to 1200 bytes)
 *   answer   "NPNG" | 0 | the reply's payload     or     "NPNG" | 1 | error message
 * Usage like iputils ping: ping [-c count] [-i interval] [-W timeout] [-s size] [-q] host.   cc -O2 -o ping ping.c -lm */
#define _DEFAULT_SOURCE
#include <arpa/inet.h>
#include <math.h>
#include <netdb.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define BRIDGE "10.0.2.2"
#define PORT 7007
#define MAXLOAD 1200

static volatile sig_atomic_t stop;
static void on_int(int s) { (void)s; stop = 1; }
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
static void usage(void) { fprintf(stderr, "usage: ping [-c count] [-i interval] [-W timeout] [-s size] [-q] host\n"); exit(2); }

int main(int argc, char **argv) {
    long count = -1, size = 56; double interval = 1, wait_s = 2; int quiet = 0, o;
    while ((o = getopt(argc, argv, "c:i:W:w:s:q46")) != -1) switch (o) {
        case 'c': count = atol(optarg); break;
        case 'i': interval = atof(optarg); if (interval < 0.2) interval = 0.2; break;   /* the server allows 10 pings/s */
        case 'W': case 'w': wait_s = atof(optarg); break;
        case 's': size = atol(optarg); break;
        case 'q': quiet = 1; break;
        case '4': case '6': break;
        default: usage();
    }
    if (optind != argc - 1) usage();
    if (size < 16) size = 16;
    if (size > MAXLOAD) { fprintf(stderr, "ping: packet size %ld is too large (at most %d here)\n", size, MAXLOAD); return 2; }
    const char *host = argv[optind];

    struct addrinfo hints = {0}, *ai; hints.ai_family = AF_INET; hints.ai_socktype = SOCK_DGRAM;
    int e = getaddrinfo(host, NULL, &hints, &ai);
    if (e) { fprintf(stderr, "ping: %s: %s\n", host, e == EAI_NONAME ? "Name or service not known" : gai_strerror(e)); return 2; }
    char ip[INET_ADDRSTRLEN]; inet_ntop(AF_INET, &((struct sockaddr_in *)ai->ai_addr)->sin_addr, ip, sizeof ip); freeaddrinfo(ai);

    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in br = {0}; br.sin_family = AF_INET; br.sin_port = htons(PORT); inet_pton(AF_INET, BRIDGE, &br.sin_addr);
    if (fd < 0 || connect(fd, (struct sockaddr *)&br, sizeof br) < 0) { perror("ping: socket"); return 2; }
    signal(SIGINT, on_int);

    unsigned id = (unsigned)getpid() * 2654435761u ^ (unsigned)now_ms();
    unsigned char req[5 + 16 + MAXLOAD], ans[8 + MAXLOAD];
    size_t hl = strlen(ip), head = 5 + hl;
    memcpy(req, "NPNG", 4); req[4] = (unsigned char)hl; memcpy(req + 5, ip, hl);
    printf("PING %s (%s) %ld(%ld) bytes of data.\n", host, ip, size, size + 28); fflush(stdout);

    long sent = 0, recvd = 0, errs = 0, seq = 0; double t0 = now_ms(), mn = 1e18, mx = 0, sum = 0, sum2 = 0;
    double *sent_at = calloc(65536, sizeof *sent_at);
    while (!stop && (count < 0 || seq < count)) {
        unsigned char *p = req + head; unsigned s16 = (unsigned)(++seq & 0xffff);
        memcpy(p, &id, 4); p[4] = s16 & 0xff; p[5] = s16 >> 8;
        for (long i = 6; i < size; i++) p[i] = (unsigned char)(0x10 + i);   /* iputils-style pattern after our header */
        sent_at[s16] = now_ms();
        if (send(fd, req, head + size, 0) < 0) { perror("ping: send"); break; }
        sent++;
        /* Wait out the interval (or, for the last one, the timeout), printing whatever replies arrive. */
        double until = sent_at[s16] + 1e3 * ((count >= 0 && seq >= count) ? wait_s : interval);
        for (;;) {
            double left = until - now_ms(); if (left <= 0 || stop) break;
            struct pollfd pf = { fd, POLLIN, 0 };
            if (poll(&pf, 1, (int)ceil(left)) <= 0) continue;
            ssize_t n = recv(fd, ans, sizeof ans, 0);
            if (n < 5 || memcmp(ans, "NPNG", 4)) continue;
            if (ans[4] == 1) { errs++; printf("From %s: %.*s\n", BRIDGE, (int)(n - 5), (char *)ans + 5); fflush(stdout); continue; }
            if (n < 5 + 6) continue;
            unsigned rid; memcpy(&rid, ans + 5, 4); unsigned rs = ans[9] | ans[10] << 8;
            if (rid != id || !sent_at[rs]) continue;
            double rtt = now_ms() - sent_at[rs]; sent_at[rs] = 0;
            recvd++; sum += rtt; sum2 += rtt * rtt; if (rtt < mn) mn = rtt; if (rtt > mx) mx = rtt;
            if (!quiet) { printf("%zd bytes from %s: icmp_seq=%u time=%.*f ms\n", n - 5 + 8, ip, rs, rtt < 10 ? 2 : 1, rtt); fflush(stdout); }
            if (count >= 0 && recvd + 0 >= count && seq >= count) break;
        }
    }
    printf("\n--- %s ping statistics ---\n%ld packets transmitted, %ld received, %g%% packet loss, time %.0fms\n",
           host, sent, recvd, sent ? 100.0 * (sent - recvd) / sent : 0, now_ms() - t0);
    if (recvd) { double avg = sum / recvd; printf("rtt min/avg/max/mdev = %.3f/%.3f/%.3f/%.3f ms\n", mn, avg, mx, sqrt(fmax(0, sum2 / recvd - avg * avg))); }
    else if (sent && !errs) printf("(no replies: is the page's ping bridge up? it needs a Wisp server with the 0xE1 ping extension)\n");
    return recvd ? 0 : 1;
}
