# DevVM spaces for Herdr

**New DevVM Space…** makes a Git worktree on a Linux SSH host. DevVM gives the guest its own Git clone. Herdr opens a space in that guest, so new tabs and splits in the space also run there.

This is a personal mod, not a built-in Herdr feature. Install it only if you trust the code. The mod can run commands as your desktop and SSH users.

## Compatibility

| Component | Supported or required version |
| --- | --- |
| Herdr desktop app | **0.1.16 only**. The installer patches copies of this release's default layout and mods. Use a Linux or macOS desktop. The native checks in this package were run on Linux, not macOS. |
| Herdr Core (`hc`) | **0.1.13** is the test baseline. The mod accepts stable **0.1.x from 0.1.13** on the desktop and source host if the required machine and layout APIs still work. Later versions are not certified by the version check. |
| Source host and DevVM | Linux **x86_64 or arm64**, **DevVM 0.1.0 only**. The guest connection depends on this release's SSH config and host key files. No local repositories, Windows hosts or desktops, macOS source hosts, or `hc machine add --via` sources. |
| Source tools | **Worktrunk 0.82.0** (`wt`), Git with `rev-parse --path-format` (tested with **2.43.0**), OpenSSH **8.7+**, Lima **2.0+** for DevVM 0.1.0, QEMU for the host architecture, and read/write access to `/dev/kvm`. |
| Installer and tests | **Python 3.9+** on the desktop. The test suite also needs Git, a POSIX shell, and **Node.js 20+** for dialog tests. |

Sources: [Herdr App v0.1.16 mods](https://github.com/herdrdev/herdr-app/blob/v0.1.16/docs/mods.md), [Core v0.1.13 machines](https://github.com/herdrdev/herdr-core/blob/v0.1.13/docs/machines.md), [DevVM v0.1.0 Lima requirements](https://github.com/devvmhq/devvm/blob/v0.1.0/docs/content/docs/backends/lima.md), [DevVM v0.1.0 SSH](https://github.com/devvmhq/devvm/blob/v0.1.0/docs/content/docs/using/ssh.md), and [Worktrunk v0.82.0](https://github.com/max-sixty/worktrunk/releases/tag/v0.82.0).

## First-time setup

### 1. Prepare the Linux host

Use an SSH account that owns the repo and can run VMs without `sudo`. Install and enable an SSH server, Git, and the OpenSSH client (`ssh` and `ssh-keygen`). If the host is itself a VM, enable nested virtualization. DevVM recommends 8 GiB of RAM, 4 CPUs, and at least 8 GiB of free disk space for the first VM. A first build also needs network access for images and packages.

Install [Worktrunk 0.82.0](https://github.com/max-sixty/worktrunk/releases/tag/v0.82.0) from its release and put `wt` on the SSH user's path. You do not need its shell integration. Install [DevVM 0.1.0](https://github.com/devvmhq/devvm/releases/tag/v0.1.0) yourself. For example, on the host, in a new download directory:

```sh
base=https://github.com/devvmhq/devvm/releases/download/v0.1.0
curl -fsSLO "$base/install.sh" && curl -fsSLO "$base/SHA256SUMS" && curl -fsSLO "$base/SHA256SUMS.minisig"
```

With `minisign` installed, verify the downloads. Check that the trusted comment is `devvm 0.1.0` and that the checksum output includes `install.sh: OK`. If either check fails, stop.

```sh
minisign -Vm SHA256SUMS -P RWSjzFsn7ETaijKJ2y7F4DtZobXmyv+LmdclJwZP/KmAkLUwOCzWF/2b && \
  sha256sum -c --ignore-missing SHA256SUMS
```

Then run `bash install.sh --version 0.1.0 --no-deps`. This installs DevVM for your user; it does not install Lima or QEMU. Use your package manager for QEMU (`qemu-img` and `qemu-system-x86_64` or `qemu-system-aarch64`), and use [Lima's official installation guide](https://lima-vm.io/docs/installation/) for `limactl`. If `devvm doctor` reports a KVM problem, enable virtualization or ask the administrator to give your account access to `/dev/kvm`. Log out and back in after a group change. See [DevVM's tagged install guide](https://github.com/devvmhq/devvm/blob/v0.1.0/docs/content/docs/getting-started/install.md) for the install options.

Check the host tools as the same SSH user. The mod adds `~/.local/bin` and `~/.local/share/mise/shims` to the non-interactive SSH path. If tools live elsewhere, make sure non-interactive SSH and Herdr can find them; a path set only in an interactive shell may not work.

```sh
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
git --version
wt --version
ssh -V
limactl --version
qemu-img --version
ls -l /dev/kvm
devvm --version
devvm doctor
```

Run `devvm doctor` without `--json`: the JSON form exits successfully even when it reports missing dependencies. Fix the problems it reports. If this account has never used DevVM, run `devvm setup` in an interactive host terminal to choose your user defaults. Keep the default `allowlist` network tier unless you know you need another tier. Test `devvm --clone` in a **disposable Git repo with a commit and a branch checked out**. Wait for its guest shell, then exit it. This tests the build and guest launch before you try the mod. This manual check creates a VM; it is not part of preflight. See [Your first VM](https://github.com/devvmhq/devvm/blob/v0.1.0/docs/content/docs/getting-started/first-vm.md).

### 2. Check desktop SSH and add the source to Herdr

In a desktop terminal, replace `devbox` with your SSH config alias or `user@host`. Use the same account for Herdr and direct SSH. Verify your host fingerprint before you trust it. Use keys or an agent available to Herdr; a password, MFA prompt, or host key prompt cannot run in the dialog. Put ports and jump hosts in SSH config, not in the target string.

```sh
ssh devbox                         # Verify the host key and log in once, then exit.
ssh -o BatchMode=yes -- devbox true
hc machine add devbox --name devbox  # Review any prompt to install Core on the source.
hc machine ls                       # Check that devbox is connected and has a supported Core.
```

If the machine is already in Herdr, do not add it again. Use its SSH **target** for `--source` below, which can differ from its display name.

### 3. Check and install the mod on the desktop

Open Herdr App 0.1.16 once to write its default files. From this package directory:

```sh
python3 install.py --check --source devbox
python3 install.py
herdr-app do layout.switch --name main-devvm
```

Use `--app /path/to/herdr-app` if the app CLI is not on your path. `--check` reads the CLI versions and validates the default layout and patch points. Add `--core /path/to/hc` if your terminal uses a different executable than Herdr. Use `--app-home /path/to/herdr-app-home` if needed. It defaults to `$HERDR_APP_HOME`, then `${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app`. The app, installer, and `layout.switch` must use the same app home. Use `--check` without `--source` for a desktop-only check. Switch back to `main` before upgrading the app. Personal copies do not update with the app and are not supported after an app upgrade.

`--check --source` runs basic dependency and KVM permission checks over batch SSH. It does not test whether a VM will boot, run `devvm setup` or `devvm doctor`, start a VM, or contact the desktop Core daemon. Fix the reported errors and run the check again. No tool is installed by preflight. Installation adds only `layouts/main-devvm.json` and `mods/devvm-{spaces,menu,worktree}`. It does not edit shipped or personal layouts, change SSH config, switch layouts for you, or update or restart your Core. It refuses to replace files from a previous installation.

## Use and recover

1. Open a Git space on your Linux SSH host. Right-click the space in the sidebar and choose **New DevVM Space…**. If you do not see it, check that `main-devvm` is active and that Herdr can see Git in the space's current folder.
2. Use **Check setup** if you want to check the Herdr connection and the host tools without creating anything. Enter a branch name and select **Create** or press Enter. A new branch starts at the source checkout's current `HEAD`. If the branch already exists and is checked out elsewhere, use another branch or resolve that checkout yourself.
3. Leave the dialog open while it works. It blocks clicks outside. While it has focus it uses a dialog Escape binding to ignore Escape during setup; when idle, Escape closes it. Closing the window or dismissing the overlay by another Herdr command is not a reliable cancellation. If it closes, check `devvm ls` and the host logs before retrying, especially if the VM may still be starting. Do not start concurrent setup attempts for the same checkout.
4. On failure, read the next step in the dialog. **Copy details** copies command output and relevant host, repo, branch, worktree or guest information. Review and redact it before sharing. Fix the issue and choose **Retry**. If you closed the dialog, reopen it from the same source repo and enter the same branch. It checks the worktree's Git identity and reuses a matching VM registration or space. It does not delete work after a failure.

| Failure | Next step |
| --- | --- |
| SSH host setup check | Run `ssh -o BatchMode=yes -- devbox true` from the desktop and `devvm doctor` on the host. Check that Herdr and SSH use the same account and that remote shell startup does not print to stdout. |
| Worktree setup | Check the branch name, current repo, and the worktree root in `settings.json` (`worktrees.directory`). It defaults to `~/.herdr/worktrees` on the host. Use a writable path. Do not remove a checkout before saving its changes. |
| DevVM build or start | Check `devvm ls` and the log named in the copied details. The app waits up to 10 minutes for boot. If more time or input is needed, use `devvm --clone` interactively from the exact host worktree, then exit the guest shell and retry. If DevVM reports an unfinished or non-clone VM, inspect it and save any work before accepting a destructive operation. |
| Guest registration or layout | Check **Settings → Machines** and `herdr-app status`. If the SSH pin is missing or no longer matches, inspect the guest from the source host. Use `devvm host --here` from its worktree to start a stopped VM. Do not disable host key verification to make registration work. |

## Data, connections, and cleanup

- DevVM seeds the guest from Git commits, not uncommitted, untracked, or ignored files. A dirty worktree gets a warning. Retry does not refresh an existing guest clone and guest edits do not sync back automatically. See [Working on a clone](https://github.com/devvmhq/devvm/blob/v0.1.0/docs/content/docs/using/clone.md) for fetching guest commits.
- The desktop connects through the source SSH host. The bridge requires DevVM's pinned host key and a loopback SSH entry on that host. It does not add a public guest SSH port, add a DevVM Include to your SSH config, or move guest keys to the desktop. DevVM can forward other ports according to its own settings.
- **Create** can install Core in the guest through `hc machine add --install`. It does not install DevVM or update the desktop/source Core. It registers a regular guest machine because Herdr App 0.1.16 does not show spaces for temporary machine registrations. Keep this app home and the SSH target stable: the connection points to this installed `bridge.sh` and the source's DevVM data path. A moved app home, renamed SSH target, or changed `XDG_DATA_HOME` can require manual re-registration after you inspect the old entry.
- Close a space to remove it from the layout; this does not stop the VM. To clean up, save guest work first. Forget the guest machine in Herdr if you no longer need it, then run `devvm rm` interactively from its host worktree and review the prompts. Remove the Git worktree last. The mod never runs `devvm rm`.
- To remove or reinstall the mod, switch to `main` first with `herdr-app do layout.switch --name main`. Back up the four installed paths listed above. Move those paths out of the app home, then reinstall if needed. A registered guest needs `bridge.sh` to reconnect; keep it at the same path if you still use that guest. The mod has no automatic update or uninstall.

## Tests

From this package directory:

```sh
python3 -B -m unittest discover -s tests -v
node --test tests/dialog.test.mjs
sh -n host.sh && sh -n bridge.sh
```

The tests use disposable Git repos and stub network and application calls. They cover install refusal, retry, dirty worktrees, host/repo/branch identity, and fail-closed guest SSH arguments. To repeat the Git worktree tests with real Worktrunk 0.82.0, set `DEVVM_TEST_WT="$(command -v wt)"` for the Python command.

For a native render check, get the official Herdr App 0.1.16 executable and a Git checkout with tag `v0.1.16`. Run `sh tests/check-herdr.sh /path/to/app-checkout /path/to/herdr-app /path/to/hc`. This installs into a temporary home and uses the real app checker for the three copied mods and the busy and error dialog renders. On Linux with no system fonts, set `DEVVM_TEST_FONT_DIR` to a directory of fallback fonts. This is not a live SSH, VM, or keyboard test. For a full smoke test, use a disposable desktop Core session and source repo. Create a guest space, check that a new tab runs in the guest, then repeat the same branch and verify that it selects the same space.

## License

This mod uses the [MIT License](LICENSE). The Herdr files copied at install time remain subject to [Herdr App's upstream license](https://github.com/herdrdev/herdr-app/blob/v0.1.16/LICENSE).
