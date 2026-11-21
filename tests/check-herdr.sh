#!/bin/sh
# Usage: sh tests/check-herdr.sh /path/to/tagged-app-repo /path/to/herdr-app /path/to/hc
set -eu
[ "$#" -eq 3 ] || { echo 'Pass the Herdr App Git checkout, app binary, and hc binary (absolute paths).' >&2; exit 2; }
package=$(cd "$(dirname "$0")/.." && pwd -P)
repo=$1 app=$2 core=$3
# Use the same Python after isolating HOME. Put the actual executable on PATH,
# not a shim that needs config from your real home.
python=$(python3 -c 'import sys; print(sys.executable)')
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/app" "$fixture/home" "$fixture/cache" "$fixture/config" "$fixture/data" "$fixture/state" "$fixture/run" "$fixture/bin"
chmod 700 "$fixture/run"
git -C "$repo" archive --output="$fixture/defaults.tar" v0.1.16 defaults
tar -xf "$fixture/defaults.tar" -C "$fixture/app" --strip-components=1
export HOME="$fixture/home" HERDR_APP_HOME="$fixture/app"
export XDG_CACHE_HOME="$fixture/cache" XDG_CONFIG_HOME="$fixture/config" XDG_DATA_HOME="$fixture/data"
export XDG_STATE_HOME="$fixture/state" XDG_RUNTIME_DIR="$fixture/run"
if [ -n "${DEVVM_TEST_FONT_DIR-}" ]; then
    FONTCONFIG_FILE="$fixture/fonts.conf"
    export FONTCONFIG_FILE
    "$python" - "$DEVVM_TEST_FONT_DIR" "$fixture/cache" > "$FONTCONFIG_FILE" <<'PY'
from html import escape
import sys
print(f'<fontconfig><dir>{escape(sys.argv[1])}</dir><cachedir>{escape(sys.argv[2])}</cachedir></fontconfig>')
PY
fi
"$python" "$package/install.py" --app "$app" --core "$core" --check
"$python" "$package/install.py" --app "$app"
# The shipped Spaces mod calls hc machine ls during its check. Stub that
# query so the checker cannot connect to or start a core.
printf '%s\n' '#!/bin/sh' '[ "$*" = "machine ls --json" ] && printf '\''{"machines":[]}\n'\''' > "$fixture/bin/hc"
chmod 700 "$fixture/bin/hc"
export PATH="$fixture/bin:$PATH" HC_SOCKET="$fixture/run/check.sock"
for mod in devvm-spaces devvm-menu devvm-worktree; do "$app" check "$HERDR_APP_HOME/mods/$mod"; done
# The regular checker supplies no DevVM action props. Render the busy and
# failure states with synthetic props as well, without executing any command.
mkdir "$fixture/dialog"
cp "$package/dialog.js" "$package/devvm.js" "$fixture/dialog/"
cp "$HERDR_APP_HOME/mods/worktree/mod.json" "$fixture/dialog/"
for state in busy error; do
    case "$state" in
        busy) flags='this.dialog.busy = true; this.dialog.stage = "Starting DevVM…";' ;;
        error) flags='this.dialog.failed = "create"; this.dialog.error = new Error("DevVM setup failed"); this.dialog.error.advice = "Check the backend and retry.";' ;;
    esac
    printf '%s\n' \
        'import { View } from "gpui-kit";' \
        'import { DevVMDialog } from "./dialog.js";' \
        'export default class Fixture extends View {' \
        '  init(_p, cx) {' \
        '    this.dialog = new DevVMDialog(cx, { on: () => "fixture", close() {}, load() { throw new Error("do not load"); } });' \
        '    this.dialog.repo = { cwd: "/fixture" };' \
        "    $flags" \
        '  }' '  render() { return this.dialog.render(); }' '}' > "$fixture/dialog/main.js"
    printf 'Checking DevVM %s render\n' "$state"
    "$app" check "$fixture/dialog"
done
