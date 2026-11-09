# The message of the day at every interactive login shell (Ubuntu shows /etc/motd through PAM, which does not run here),
# unless ~/.hidemotd exists.
case $- in *i*)
  if [ -r /etc/motd ] && [ ! -e "$HOME/.hidemotd" ]; then cat /etc/motd; fi ;;
esac
