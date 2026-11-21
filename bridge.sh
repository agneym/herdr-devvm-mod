#!/bin/sh
# hc appends its guest command as the last argument. Pass it on as one argument.
set -eu
[ "$#" -eq 4 ]
quote() {
    printf "'"
    printf '%s' "$1" | sed "s/'/'\\\\''/g"
    printf "'"
}
inner='
set -eu
config=$1 vm=$2 command=$3
fail() { printf "%s\n" "DevVM SSH: $*" >&2; exit 1; }
settings=$(ssh -G -T -F "$config" -- "$vm") || fail "Could not read $config. Start or retry the VM on the source host."
field() { printf "%s\n" "$settings" | awk -v key="$1" '\''$1 == key { sub(/^[^ ]* /, ""); print; exit }'\''; }
port=$(field port)
known=$(field userknownhostsfile)
[ "$(field hostname)" = 127.0.0.1 ] && [ "$(field hostkeyalias)" = "$vm" ] && \
    [ "$known" = "${config%/*}/vms/${vm##*-}/run/known_hosts" ] || \
    fail "No pinned loopback SSH entry for $vm. Start or retry the VM on the source host."
case "$port" in ""|*[!0-9]*) fail "Invalid port for $vm." ;; esac
[ "$port" -gt 0 ] && [ "$port" -le 65535 ] || fail "Invalid port for $vm."
ssh-keygen -F "$vm" -f "$known" >/dev/null 2>&1 || fail "No pinned host key for $vm."
exec ssh -T -F "$config" -p "$port" -o BatchMode=yes -o ConnectTimeout=10 \
    -o HostName=127.0.0.1 -o HostKeyAlias="$vm" -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=\"$known\"" -o GlobalKnownHostsFile=none \
    -o VerifyHostKeyDNS=no -o NoHostAuthenticationForLocalhost=no -o UpdateHostKeys=no \
    -o ControlPath=none -o ProxyCommand=none -o ProxyJump=none \
    -o ClearAllForwardings=yes -o ForwardAgent=no -- "$vm" "$command"
'
# An empty source target means the guest port is on this desktop's loopback.
if [ -z "$1" ]; then
    exec sh -c "$inner" herdr-devvm "$2" "$3" "$4"
fi
exec ssh -T -o BatchMode=yes -o ConnectTimeout=10 -- "$1" \
    "exec sh -c $(quote "$inner") herdr-devvm $(quote "$2") $(quote "$3") $(quote "$4")"
