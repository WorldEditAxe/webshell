#!/bin/bash
# install-desktop.sh: a lightweight desktop on the virtual screen. Xorg (fbdev on /dev/fb0, evdev on
# /dev/input/event0 + event1), the JWM window manager with its taskbar and menu, and xterm. About 24 MB download, a few minutes here.
# Then: startdesktop (open the monitor tab in the top bar, and click the screen to use mouse + keyboard).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update

# Xorg's package dependencies pull in Mesa + LLVM (41 MB) and udev + systemd, none of which Xorg uses on a plain
# framebuffer here (no GPU, no udev). A stub package that provides them keeps them out: 24 MB instead of 93 MB.
v() { apt-cache show --no-all-versions "$1" | awk '/^Version:/ { print $2; exit }'; }
stub=$(mktemp -d); mkdir "$stub/DEBIAN"
cat > "$stub/DEBIAN/control" <<EOF
Package: nanite-desktop-stubs
Version: 1
Architecture: all
Maintainer: Nanite Webshell <root@localhost>
Provides: mesa-libgallium (= $(v mesa-libgallium)), libllvm21 (= $(v libllvm21)), libgl1-mesa-dri (= $(v libgl1-mesa-dri)),
 libglx-mesa0 (= $(v libglx-mesa0)), libegl-mesa0 (= $(v libegl-mesa0)), udev (= $(v udev)), systemd (= $(v systemd))
Description: stands in for the GPU and udev packages that Xorg on /dev/fb0 never uses
EOF
dpkg-deb -b "$stub" "$stub.deb" >/dev/null && dpkg -i "$stub.deb" && rm -rf "$stub" "$stub.deb"

apt-get install -y --no-install-recommends xserver-xorg-core xserver-xorg-video-fbdev xserver-xorg-input-evdev xinit jwm xterm \
  libxtst6

# No udev and no VTs here: name the mouse outright, and run Xorg on a seat other than seat0 (it then leaves VTs alone). The
# keyboard is not an Xorg device: evdev cannot open Nanite's event0, so nanite-xkeys (/usr/local/src/nanite-xkeys) types its keys
# in through XTest. GLX is off: there is no GPU, and the software renderer (Mesa) is not installed.
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/10-nanite.conf <<'EOF'
Section "ServerFlags"
    Option "AutoAddDevices" "false"
    Option "AutoEnableDevices" "false"
EndSection
Section "Module"
    Disable "glx"
EndSection
Section "Device"
    Identifier "fb"
    Driver "fbdev"
    Option "fbdev" "/dev/fb0"
EndSection
Section "Screen"
    Identifier "screen"
    Device "fb"
    DefaultDepth 24
EndSection
Section "InputDevice"
    Identifier "mouse"
    Driver "evdev"
    Option "Device" "/dev/input/event1"
    # No pointer acceleration: the page's absolute mouse mode moves the cursor by exact distances.
    Option "AccelerationProfile" "-1"
    Option "AccelerationScheme" "none"
EndSection
Section "ServerLayout"
    Identifier "layout"
    Screen "screen"
    InputDevice "mouse" "CorePointer"
EndSection
EOF

# xterm in the webshell's colours (Afterglow with a sakura tint).
cat > /etc/X11/nanite-xterm.ad <<'EOF'
XTerm*faceName: Monospace
XTerm*faceSize: 11
XTerm*utf8: true
XTerm*termName: xterm-256color
XTerm*scrollBar: false
XTerm*internalBorder: 6
XTerm*background: #221d21
XTerm*foreground: #d6cfd3
XTerm*cursorColor: #f2b5c8
XTerm*highlightColor: #4a3442
XTerm*color0: #171316
XTerm*color1: #ac4142
XTerm*color2: #7e8e50
XTerm*color3: #e5b567
XTerm*color4: #6c99bb
XTerm*color5: #b05a8e
XTerm*color6: #7dd6cf
XTerm*color7: #d6cfd3
XTerm*color8: #5a4f56
XTerm*color9: #ac4142
XTerm*color10: #7e8e50
XTerm*color11: #e5b567
XTerm*color12: #6c99bb
XTerm*color13: #e39cbc
XTerm*color14: #7dd6cf
XTerm*color15: #f7f0f3
EOF

# JWM: a menu (click the desktop, or the first tray button), a terminal button, the task list, desktops and a clock.
cat > "$HOME/.jwmrc" <<'EOF'
<?xml version="1.0"?>
<JWM>
  <RootMenu onroot="123">
    <Program label="Terminal">xterm</Program>
    <Program label="usage">xterm -T usage -hold -e usage</Program>
    <Program label="top">xterm -T top -e top</Program>
    <Separator/>
    <Restart label="Restart JWM"/>
    <Exit label="Exit" confirm="false"/>
  </RootMenu>
  <Tray x="0" y="-1" height="28" autohide="off">
    <TrayButton label="Menu">root:1</TrayButton>
    <TrayButton label="Terminal">exec:xterm</TrayButton>
    <TaskList maxwidth="240"/>
    <Pager labeled="true"/>
    <Clock format="%H:%M"><Button mask="123">exec:xterm -T usage -hold -e usage</Button></Clock>
  </Tray>
  <WindowStyle>
    <Font>Sans-10</Font><Width>3</Width><Height>22</Height><Corner>4</Corner>
    <Foreground>#d6cfd3</Foreground><Background>#2b2429</Background><Outline>#4a3442</Outline>
    <Active><Foreground>#221d21</Foreground><Background>#f2b5c8</Background><Outline>#b0798f</Outline></Active>
  </WindowStyle>
  <TrayStyle><Font>Sans-10</Font><Foreground>#d6cfd3</Foreground><Background>#1a1619</Background></TrayStyle>
  <TaskListStyle><Font>Sans-10</Font><Foreground>#d6cfd3</Foreground><Background>#1a1619</Background>
    <Active><Foreground>#221d21</Foreground><Background>#f2b5c8</Background></Active></TaskListStyle>
  <PagerStyle><Foreground>#2b2429</Foreground><Background>#1a1619</Background><Text>#d6cfd3</Text>
    <Active><Foreground>#4a3442</Foreground><Background>#b0798f</Background></Active></PagerStyle>
  <MenuStyle><Font>Sans-10</Font><Foreground>#d6cfd3</Foreground><Background>#221d21</Background><Outline>#4a3442</Outline>
    <Active><Foreground>#221d21</Foreground><Background>#f2b5c8</Background></Active></MenuStyle>
  <Desktops width="2" height="1"><Background type="solid">#221d21</Background></Desktops>
  <StartupCommand>xterm</StartupCommand>
  <Key mask="A" key="Tab">nextstacked</Key>
  <Key mask="A" key="F4">close</Key>
</JWM>
EOF

mkdir -p /usr/local/lib/nanite-desktop
cat > /usr/local/lib/nanite-desktop/session <<'EOF'
#!/bin/sh
export XENVIRONMENT=/etc/X11/nanite-xterm.ad
/usr/local/bin/nanite-xkeys &
exec jwm
EOF
chmod +x /usr/local/lib/nanite-desktop/session

cat > /usr/local/bin/startdesktop <<'EOF'
#!/bin/sh
# startdesktop: Xorg + JWM on the virtual screen. Quit with the JWM menu (Exit) or Ctrl+C here.
[ -e /dev/fb0 ] || { echo "startdesktop: no /dev/fb0"; exit 1; }
echo "desktop: open the monitor tab (top bar) and click the screen; Esc releases the mouse."
exec xinit /usr/local/lib/nanite-desktop/session -- /usr/lib/xorg/Xorg :0 -seat seat1 -nolisten tcp -noreset -logfile /tmp/Xorg.0.log
EOF
chmod +x /usr/local/bin/startdesktop
echo; echo "Installed. Run: startdesktop"
