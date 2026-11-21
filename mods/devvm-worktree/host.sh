#!/bin/sh
# Invoked on the source host (local or SSH). Stdout is for the mod.
set -eu
PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
platform=$(uname -s)
# GUI apps and non-interactive SSH on macOS may not inherit Homebrew's PATH.
if [ "$platform" = Darwin ]; then PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; fi
export PATH
fail() { printf '%s\n' "$*" >&2; exit 1; }
check_adapter() {
    case "$1" in
        '') ;;
        /*) [ -f "$1" ] && [ -x "$1" ] || fail "Worktree adapter is not an executable file: $1" ;;
        *) fail 'worktrees.devvmAdapter must be an absolute executable path on the source host.' ;;
    esac
}
check_platform() {
    case "$platform:$(uname -m)" in
        Linux:x86_64) qemu=qemu-system-x86_64 ;;
        Linux:aarch64) qemu=qemu-system-aarch64 ;;
        Darwin:arm64|Darwin:x86_64)
            release=$(sw_vers -productVersion) || fail 'Could not determine the macOS version.'
            [ "${release%%.*}" -ge 13 ] || fail 'DevVM requires macOS 13 or newer.'
            ;;
        *) fail 'Use a macOS or Linux source host on arm64 or x86_64.' ;;
    esac
}
check_devvm() {
    command -v devvm >/dev/null || fail 'Install DevVM 0.1.0 on the source host. See First-time setup in README.md.'
    version=$(devvm --version) || fail 'Could not run devvm --version on the source host.'
    [ "$version" = '0.1.0' ] || fail "Expected DevVM 0.1.0 on the source host; found $version."
}
ssh_config() {
    case "${XDG_DATA_HOME-}" in
        /*) data=$XDG_DATA_HOME ;;
        *) data=$HOME/.local/share ;;
    esac
    printf '%s\n' "$data/devvm/ssh_config"
}
canonical() { (cd "$1" && pwd -P); }
suffix() {
    digest=$(printf '%s' "$1" | git hash-object --stdin) || return 1
    printf '%.16s' "$digest"
}
component() { printf '%s' "$1" | LC_ALL=C tr -cs 'a-zA-Z0-9._-' '-' | cut -c 1-48; }
matches_checkout() {
    [ -f "$1/.git" ] && [ "$(git -C "$1" symbolic-ref -q HEAD)" = "refs/heads/$branch" ] || return 1
    other=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir) || return 1
    [ "$(canonical "$other")" = "$common" ]
}
mode=$1
shift
case "$mode" in
    probe)
        check_platform
        check_devvm
        ;;
    preflight)
        check_platform
        command -v git >/dev/null || fail 'Install Git on the source host.'
        check_adapter "${1-}"
        check_devvm
        set -- ssh ssh-keygen limactl
        if [ "$platform" = Linux ]; then set -- "$@" qemu-img "$qemu"; fi
        for tool do
            command -v "$tool" >/dev/null || fail "Missing $tool on the source host. Install it or fix the application's or SSH session's PATH, then run devvm doctor on the host."
        done
        if [ "$platform" = Linux ]; then
            [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ] ||
                fail 'The source user needs read/write access to /dev/kvm. Enable (nested) virtualization and check KVM group membership. Log in again after changes, then run devvm doctor on the host.'
        fi
        ssh_config
        ;;
    worktree)
        branch=$1
        legacy=$2
        adapter=${3-}
        case "$legacy" in
            /*) ;;
            *) fail 'worktrees.directory must resolve to an absolute path on the source host.' ;;
        esac
        check_adapter "$adapter"
        command -v git >/dev/null || fail 'Install Git on the source host and check Herdr Core’s PATH.'
        # Exit 64 lets the dialog show a fixed validation message, not raw output.
        case "$branch" in -*|@) printf '%s\n' 'Enter a Git branch name.' >&2; exit 64 ;; esac
        git check-ref-format "refs/heads/$branch" || { printf '%s\n' 'Enter a valid Git branch name.' >&2; exit 64; }
        base=$(git rev-parse --verify --quiet 'HEAD^{commit}') || fail 'Make an initial Git commit in the source repository first.'
        common=$(git rev-parse --path-format=absolute --git-common-dir)
        common=$(canonical "$common")
        repo_path=${legacy%/*}
        repo_suffix=$(suffix "$common")
        branch_suffix=$(suffix "$branch")
        path="${repo_path%/*}/$(component "${repo_path##*/}")-$repo_suffix/$(component "${legacy##*/}")-$branch_suffix"
        # Reuse a checkout made by the first prototype only if its identity matches.
        if matches_checkout "$legacy"; then path=$legacy; fi
        if [ ! -e "$path" ] && [ ! -L "$path" ]; then
            if git show-ref --verify --quiet "refs/heads/$branch"; then
                if [ -n "$adapter" ]; then
                    "$adapter" existing "$path" "$branch" >&2
                else
                    git worktree add -- "$path" "$branch" >&2
                fi
            else
                result=$?
                [ "$result" -eq 1 ] || fail 'Could not check the branch.'
                if [ -n "$adapter" ]; then
                    "$adapter" create "$path" "$branch" "$base" >&2
                else
                    git worktree add -b "$branch" -- "$path" "$base" >&2
                fi
            fi
        fi
        matches_checkout "$path" || fail "No matching linked worktree at $path. Check if the branch is already open elsewhere."
        cd "$path"
        changes=$(git --no-optional-locks -c core.fsmonitor=false status --porcelain)
        pwd -P
        if [ -n "$changes" ]; then printf 'dirty\n'; else printf 'clean\n'; fi
        ;;
    boot)
        check_devvm
        cd "$1"
        devvm --clone --no-input </dev/null >&2
        devvm ls --json
        ;;
    *) fail 'Unknown DevVM host action.' ;;
esac
