# The Nanite Webshell's fish (root's login shell in the demo root). No greeting; the message of the day at every interactive
# login (Ubuntu shows /etc/motd through PAM, which does not run here) unless ~/.hidemotd exists.
set -g fish_greeting ""
if status is-interactive; and status is-login; and test -r /etc/motd; and not test -e ~/.hidemotd
    cat /etc/motd
end
