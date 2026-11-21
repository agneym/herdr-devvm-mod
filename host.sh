#!/bin/sh
# Invoked on the source Linux machine. Output on stdout is for the mod.
set -eu
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
fail() { printf '%s\n' "$*" >&2; exit 1; }
check_worktrunk() {
    command -v wt >/dev/null || fail 'Install Worktrunk 0.82.0 (wt) on the source host. Check its non-interactive PATH.'
    version=$(wt --version) || fail 'Could not run wt --version on the source host.'
    [ "$version" = 'wt 0.82.0' ] || fail "Expected Worktrunk 0.82.0 on the source host; found $version."
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
    preflight)
        [ "$(uname -s)" = Linux ] || fail 'Use a Linux SSH source host, not the desktop or a guest.'
        case "$(uname -m)" in
            x86_64) qemu=qemu-system-x86_64 ;;
            aarch64) qemu=qemu-system-aarch64 ;;
            *) fail 'Use an x86_64 or arm64 Linux source host.' ;;
        esac
        command -v git >/dev/null || fail 'Install Git on the source host.'
        check_worktrunk
        check_devvm
        for tool in ssh ssh-keygen limactl qemu-img "$qemu"; do
            command -v "$tool" >/dev/null || fail "Missing $tool on the source host. Install it or fix the non-interactive PATH, then run devvm doctor on the host."
        done
        [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ] ||
            fail 'The SSH user needs read/write access to /dev/kvm. Enable (nested) virtualization and check KVM group membership. Log in again after changes, then run devvm doctor on the host.'
        ssh_config
        ;;
    worktree)
        branch=$1
        legacy=$2
        command -v git >/dev/null || fail 'Install Git on the source host and check Herdr Core’s PATH.'
        # Exit 64 lets the dialog show a fixed validation message, not raw output.
        case "$branch" in -*|@) printf '%s\n' 'Enter a Git branch name.' >&2; exit 64 ;; esac
        git check-ref-format "refs/heads/$branch" || { printf '%s\n' 'Enter a valid Git branch name.' >&2; exit 64; }
        check_worktrunk
        git rev-parse --verify --quiet HEAD >/dev/null || fail 'Make an initial Git commit in the source repository first.'
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
                wt switch --no-hooks --no-cd --path "$path" "$branch" >&2
            else
                result=$?
                [ "$result" -eq 1 ] || fail 'Could not check the branch.'
                wt switch --no-hooks --no-cd --create --base @ --path "$path" "$branch" >&2
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
