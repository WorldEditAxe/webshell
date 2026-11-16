#!/bin/sh
# install-ssh.sh: the OpenSSH client (ssh, scp, sftp) and a key for it (~/.ssh/id_ed25519).
#   ./install-ssh.sh          the client
#   ./install-ssh.sh server   also the server (sshd on port 22): reach it from outside with a tunnel to port 22
#                             (Settings > Network > Tunnels), logging in with a key in ~/.ssh/authorized_keys
set -eu
apk update
apk add openssh-client
mkdir -p ~/.ssh && chmod 700 ~/.ssh
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519

if [ "${1:-}" = server ]; then
  apk add openssh-server
  ssh-keygen -A >/dev/null
  touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
  # Keys only: root has no password here.
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  /usr/sbin/sshd
  echo
  echo "sshd is running on port 22. Put the public keys allowed to log in into ~/.ssh/authorized_keys, and open a tunnel"
  echo "to port 22 in Settings > Network > Tunnels; then from outside: ssh -p PORT root@ADDRESS"
  echo "(After a restart of the machine, start it again with: /usr/sbin/sshd)"
fi

echo
echo "Your public key (add it to a server's ~/.ssh/authorized_keys, or to GitHub > Settings > SSH keys):"
cat ~/.ssh/id_ed25519.pub
echo
echo "Then: ssh user@host"
