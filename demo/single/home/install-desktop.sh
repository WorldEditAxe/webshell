#!/bin/sh
# install-desktop.sh: the XFCE desktop on Nanite's virtual screen (the Display tab). Xorg (modesetting on /dev/dri/card0, or
# fbdev on /dev/fb0 with an older Nanite; evdev on /dev/input/event1) with XFCE's window manager, panel, desktop and
# terminal. About 35 MB download. On /dev/dri/card0 the desktop follows the Display tab's size (nanite-follow-screen).
# Then: startdesktop (open the Display tab from + in the top bar, and click the screen to use mouse + keyboard).
set -eu
apk update

# Xorg's packages pull in Mesa + LLVM (about 300 MB) for GPU drawing, which Nanite does not have. A stub package that provides
# them keeps them out; libgbm (mesa-gbm, small and without LLVM) is real, since the modesetting driver links it.
v=$(apk search -x mesa-gbm | sed 's/^mesa-gbm-//')
stub=$(mktemp -d)
cat > "$stub/.PKGINFO" <<EOF
pkgname = nanite-no-gpu
pkgver = 1.0-r0
pkgdesc = Nanite has no GPU: stands in for Mesa
arch = noarch
size = 1
provides = mesa=$v
provides = mesa-egl=$v
provides = mesa-gl=$v
provides = mesa-dri-gallium=$v
provides = so:libGL.so.1=1.7.0
provides = so:libEGL.so.1=1.0.0
EOF
# An apk is two gzip streams: the control tar (.PKGINFO, without the tar's end blocks) and the data tar (empty here).
(cd "$stub" && tar -cf c.tar .PKGINFO && head -c $(( $(wc -c < c.tar) - 1024 )) c.tar | gzip > a.gz \
  && mkdir d && tar -cf - -C d . | gzip > b.gz && cat a.gz b.gz > nanite-no-gpu.apk)
apk add --allow-untrusted --force-non-repository "$stub/nanite-no-gpu.apk"
rm -rf "$stub"

apk add xorg-server xf86-video-fbdev xf86-input-evdev mesa-gbm xinit xrandr libxtst dbus-x11 font-dejavu \
  xfwm4 xfce4-panel xfdesktop xfce4-terminal adwaita-icon-theme

# No udev and no VTs here: name the mouse outright, and run Xorg on a seat other than seat0 (it then leaves VTs alone). The
# keyboard is not an Xorg device: evdev cannot open Nanite's event0, so nanite-xkeys types its keys in through XTest. GLX and
# glamor are off: there is no GPU.
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/10-nanite.conf <<'EOF'
Section "ServerFlags"
    Option "AutoAddDevices" "false"
    Option "AutoEnableDevices" "false"
EndSection
Section "Module"
    Disable "glx"
    Disable "glamoregl"
EndSection
Section "InputDevice"
    Identifier "mouse"
    Driver "evdev"
    Option "Device" "/dev/input/event1"
    # No pointer acceleration: the page's absolute mouse mode moves the cursor by exact distances.
    Option "AccelerationProfile" "-1"
    Option "AccelerationScheme" "none"
EndSection
EOF
# The screen: Nanite's display connector (/dev/dri/card0, Virtual-1), whose preferred mode is the Display tab's size, or the fixed
# /dev/fb0 of an older Nanite. startdesktop picks one (-config).
for dev in kms fbdev; do
  if [ $dev = kms ]; then drv='Driver "modesetting"
    Option "kmsdev" "/dev/dri/card0"
    Option "AccelMethod" "none"'; else drv='Driver "fbdev"
    Option "fbdev" "/dev/fb0"'; fi
  cat > /etc/X11/nanite-$dev.conf <<EOF
Section "Device"
    Identifier "screen-device"
    $drv
EndSection
Section "Screen"
    Identifier "screen"
    Device "screen-device"
    DefaultDepth 24
EndSection
Section "ServerLayout"
    Identifier "layout"
    Screen "screen"
    InputDevice "mouse" "CorePointer"
EndSection
EOF
done

# The Display tab was resized: Nanite offers its size as Virtual-1's preferred mode (the first line of modes). There is no udev to
# pass the hotplug on, so this watches the connector and sets the preferred mode (xrandr re-reads the connector).
cat > /usr/local/bin/nanite-follow-screen <<'EOF'
#!/bin/sh
modes=/sys/class/drm/card0-Virtual-1/modes
[ -r "$modes" ] || exit 0
# Right after the change, X can still have the old mode list and --auto keeps the old size: it is done again until X's screen
# is the wanted size (at most 20 tries for one size).
last="" tries=0
while :; do
  want=""; read -r want < "$modes" 2>/dev/null  # a builtin: no process per check
  if [ -n "$want" ] && [ "$want" != "$last" ]; then
    xrandr --output Virtual-1 --auto >/dev/null 2>&1
    now=$(xrandr 2>/dev/null | sed -n 's/.*current \([0-9]*\) x \([0-9]*\).*/\1x\2/p')
    tries=$((tries + 1))
    if [ "$now" = "$want" ] || [ $tries -ge 20 ]; then last=$want tries=0; fi
  fi
  sleep 1
done
EOF
chmod +x /usr/local/bin/nanite-follow-screen

# XFCE: its window manager, panel and desktop. Each GTK program takes about 45 MB here (Nanite does not share libraries
# between processes), so the session manager and the settings daemon stay off: with them the desktop outgrows 512 MB.
# No compositing (every frame would be drawn twice, without a GPU); the panel's default layout (it would ask on first start);
# the dark theme from GTK's settings (without the settings daemon).
conf="$HOME/.config/xfce4/xfconf/xfce-perchannel-xml"
mkdir -p "$conf" "$HOME/.config/gtk-3.0"
cat > "$conf/xfwm4.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="use_compositing" type="bool" value="false"/>
    <property name="theme" type="string" value="Default"/>
  </property>
</channel>
EOF
[ -f "$conf/xfce4-panel.xml" ] || cp /etc/xdg/xfce4/panel/default.xml "$conf/xfce4-panel.xml"
cat > "$HOME/.config/gtk-3.0/settings.ini" <<'EOF'
[Settings]
gtk-theme-name=Adwaita
gtk-application-prefer-dark-theme=1
gtk-icon-theme-name=Adwaita
gtk-font-name=DejaVu Sans 10
EOF

mkdir -p /usr/local/lib/nanite-desktop
cat > /usr/local/lib/nanite-desktop/session <<'EOF'
#!/bin/sh
/usr/local/bin/nanite-xkeys &
/usr/local/bin/nanite-follow-screen &
# The desktop ends with the panel (close it, or Ctrl+C where startdesktop runs).
exec dbus-launch --exit-with-session sh -c 'xfwm4 --compositor=off & xfdesktop & exec xfce4-panel'
EOF
chmod +x /usr/local/lib/nanite-desktop/session

cat > /usr/local/bin/startdesktop <<'EOF'
#!/bin/sh
# startdesktop: Xorg + XFCE on the virtual screen. Quit with Ctrl+C here.
[ -e /dev/fb0 ] || { echo "startdesktop: no /dev/fb0"; exit 1; }
echo "desktop: open the Display tab (+ in the top bar) and click the screen; Esc releases the mouse."
[ -e /dev/dri/card0 ] && conf=nanite-kms.conf || conf=nanite-fbdev.conf
exec xinit /usr/local/lib/nanite-desktop/session -- /usr/libexec/Xorg :0 -seat seat1 -nolisten tcp -noreset -config $conf \
  -logfile /tmp/Xorg.0.log
EOF
chmod +x /usr/local/bin/startdesktop
echo; echo "Installed. Run: startdesktop"
