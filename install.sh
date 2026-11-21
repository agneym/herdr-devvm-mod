#!/bin/sh
# Installs the prebuilt payload from a GitHub Release (not a source checkout).
set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }
bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
home=${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}
app=herdr-app
check=no
while [ "$#" -gt 0 ]; do
    case $1 in
        --app|--app-home)
            [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value."
            if [ "$1" = --app ]; then app=$2; else home=$2; fi
            shift 2 ;;
        --check) check=yes; shift ;;
        -h|--help) printf '%s\n' 'Usage: sh install.sh [--check] [--app PATH] [--app-home DIR]'; exit ;;
        *) fail "Unknown option: $1" ;;
    esac
done

case $(uname -s) in Linux|Darwin) ;; *) fail 'Use a Linux or macOS desktop.' ;; esac
layout=main-devvm.json
mods='devvm-spaces devvm-menu devvm-worktree'
[ -f "$bundle/layouts/$layout" ] || fail 'Missing prebuilt layout. Download the release asset, not the source archive.'
for mod in $mods; do
    [ -f "$bundle/mods/$mod/main.js" ] && [ -f "$bundle/mods/$mod/mod.json" ] || fail "Incomplete release: $mod."
done
for helper in devvm.js dialog.js host.sh bridge.sh; do
    [ -f "$bundle/mods/devvm-worktree/$helper" ] || fail "Incomplete release: $helper."
done
version=$("$app" --version) || fail "Could not run $app --version."
[ "$version" = 'herdr-app 0.1.16' ] || fail "Expected herdr-app 0.1.16; found $version."
original_home=$home
home=$(CDPATH= cd -- "$home" && pwd -P) || fail "Open Herdr App 0.1.16 once to initialize $original_home."
for folder in layouts mods; do
    [ -d "$home/$folder" ] && [ ! -L "$home/$folder" ] || fail "Expected a real directory at $home/$folder."
done
[ -f "$home/layouts/main.json" ] || fail 'Open Herdr App 0.1.16 once to initialize its default layout.'
for dest in "layouts/$layout" mods/devvm-spaces mods/devvm-menu mods/devvm-worktree; do
    [ ! -e "$home/$dest" ] && [ ! -L "$home/$dest" ] || fail "Not overwriting $home/$dest. See the README for reinstall steps."
done
if [ "$check" = yes ]; then
    printf 'Release and Herdr App checked at %s. No files installed or VM started.\n' "$home"
    exit
fi

# Reserve mod paths using mkdir and publish the layout last with a hard link.
# Stage the layout alongside its destination so this also works across mounts.
stage=$(mktemp -d "$home/layouts/.devvm-install.XXXXXXXX")
created=
cleanup() {
    for mod in $created; do rm -rf -- "$home/mods/$mod"; done
    rm -rf -- "$stage"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
cp "$bundle/layouts/$layout" "$stage/$layout"
for mod in $mods; do
    mkdir "$home/mods/$mod"
    created="$created $mod"
    cp -R "$bundle/mods/$mod/." "$home/mods/$mod/"
done
# The directory form fixes the destination basename; ln never replaces it.
trap '' HUP INT TERM
ln "$stage/$layout" "$home/layouts/"
created=
printf 'Installed the DevVM layout in %s. Switch the open app to main-devvm.\n' "$home"
