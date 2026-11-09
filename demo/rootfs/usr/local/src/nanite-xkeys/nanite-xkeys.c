/* nanite-xkeys: the virtual screen's keyboard for Xorg. Xorg's evdev driver cannot open Nanite's /dev/input/event0 (an ioctl
 * it queries is not implemented: "Unable to query fd: Inappropriate ioctl for device"), so this reads the key events itself and
 * types them into the X server with the XTest extension. X keycodes are Linux key codes + 8 (XKB's evdev rules).
 * Started by startdesktop's session. Build: cc -O2 -o nanite-xkeys nanite-xkeys.c -lX11 -lXtst */
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <fcntl.h>
#include <linux/input.h>
#include <poll.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
    const char *dev = argc > 1 ? argv[1] : "/dev/input/event0";
    Display *d = NULL;
    for (int i = 0; i < 100 && !(d = XOpenDisplay(NULL)); i++) usleep(100000);
    if (!d) { fprintf(stderr, "nanite-xkeys: cannot open the X display\n"); return 1; }
    int ev_base, err_base, major, minor;
    if (!XTestQueryExtension(d, &ev_base, &err_base, &major, &minor)) { fprintf(stderr, "nanite-xkeys: no XTest extension\n"); return 1; }
    int fd = open(dev, O_RDONLY | O_NONBLOCK);
    if (fd < 0) { perror(dev); return 1; }
    struct input_event ev[64];
    struct pollfd pf[2] = { { fd, POLLIN, 0 }, { ConnectionNumber(d), POLLIN, 0 } };
    for (;;) {
        if (poll(pf, 2, 1000) < 0) usleep(16000);
        if (pf[1].revents & (POLLHUP | POLLERR)) return 0;          /* the X server went away */
        while (XPending(d)) { XEvent x; XNextEvent(d, &x); }
        ssize_t n;
        while ((n = read(fd, ev, sizeof ev)) > 0) {
            for (ssize_t i = 0; i < n / (ssize_t)sizeof ev[0]; i++)
                if (ev[i].type == EV_KEY && ev[i].value != 2 && ev[i].code < 248)   /* press / release; X repeats keys itself */
                    XTestFakeKeyEvent(d, ev[i].code + 8, ev[i].value != 0, CurrentTime);
            XFlush(d);
        }
    }
}
