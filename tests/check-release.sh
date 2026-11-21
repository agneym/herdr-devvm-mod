#!/bin/sh
# Smoke-test the exact release archive without invoking Python.
set -eu
archive=${1:?usage: check-release.sh archive.tar.gz}
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/release" "$fixture/bin" "$fixture/config space"
tar -xf "$archive" -C "$fixture/release"
installer=$fixture/release/herdr-devvm-mod/install.sh
export XDG_CONFIG_HOME="$fixture/config space"
unset HERDR_APP_HOME
home=$XDG_CONFIG_HOME/herdr-app
mkdir -p "$home/layouts" "$home/mods"
printf '%s\n' 'local layout' > "$home/layouts/main.json"
printf '%s\n' '#!/bin/sh' 'printf "herdr-app %s\n" "${APP_VERSION:-0.1.16}"' > "$fixture/bin/herdr-app"
chmod +x "$fixture/bin/herdr-app"
export PATH="$fixture/bin:$PATH"

APP_VERSION=0.1.17 sh "$installer" && exit 1
sh "$installer" --check
[ -z "$(ls -A "$home/mods")" ]
[ ! -e "$home/layouts/main-devvm.json" ]
ln -s "$home/missing" "$home/mods/devvm-menu"
sh "$installer" && exit 1
[ ! -e "$home/mods/devvm-spaces" ]
rm "$home/mods/devvm-menu"

# Fail late, after two mods have been published and the third is reserved.
printf '%s\n' '#!/bin/sh' 'case ${2-} in */devvm-worktree/.) exit 1 ;; esac' 'exec "$REAL_CP" "$@"' > "$fixture/bin/cp"
REAL_CP=$(command -v cp)
export REAL_CP
chmod +x "$fixture/bin/cp"
sh "$installer" && exit 1
[ -z "$(ls -A "$home/mods")" ]
[ "$(ls -A "$home/layouts")" = main.json ]
rm "$fixture/bin/cp"

sh "$installer"
bundle=$fixture/release/herdr-devvm-mod
cmp "$bundle/layouts/main-devvm.json" "$home/layouts/main-devvm.json"
diff -r "$bundle/mods" "$home/mods"
[ "$(grep -F 'local layout' "$home/layouts/main.json")" = 'local layout' ]
sh "$installer" && exit 1
diff -r "$bundle/mods" "$home/mods"
printf '%s\n' 'Release install, non-overwrite and rollback checks passed.'
