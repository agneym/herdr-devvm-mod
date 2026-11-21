import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


PACKAGE = Path(__file__).resolve().parents[1]


def script(path, content):
    path.write_text("#!/bin/sh\n" + content + "\n", encoding="utf-8")
    path.chmod(0o755)


class Fixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.home), "LC_ALL": "C",
                    "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "a@example.test",
                    "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "a@example.test"}

    def run_cmd(self, *args, cwd=None, ok=True):
        out = subprocess.run(args, env=self.env, cwd=cwd or self.root, capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode == 0, ok, f"{out.stdout}\n{out.stderr}")
        return out


class Installer(Fixture):
    def setUp(self):
        super().setUp()
        self.app_home = self.root / "app home"
        self.app_home.mkdir()
        script(self.bin / "herdr-app", 'test "$1" = --version && echo "herdr-app 0.1.16"')
        script(self.bin / "hc", 'test "$1" = --version && echo "hc 0.1.20"')
        (self.app_home / "layouts").mkdir()
        (self.app_home / "layouts/main.json").write_text('{"body":{"mod":"spaces"}}')
        (self.app_home / "layouts/personal.json").write_text('{"untouched":true}')
        entries = {
            "spaces": 'mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space"',
            "menu": ('spaces, panes, exec } from "herdr";\n        ...(git === "linked" ? [["Remove worktree"\n'
                     '    else run(it[1], it[2]);'),
            "worktree": ('import { View, div } from "gpui-kit";\n    this.on = this.space()?.machine;\n  render(cx) {'),
        }
        for name, entry in entries.items():
            folder = self.app_home / "mods" / name
            folder.mkdir(parents=True)
            (folder / "mod.json").write_text("{}")
            (folder / "main.js").write_text(entry)
        self.original = self.snapshot()

    def snapshot(self):
        return {p.relative_to(self.app_home): (p.read_bytes() if p.is_file() else None) for p in self.app_home.rglob("*")}

    def installer(self, *args, ok=True):
        return self.run_cmd(sys.executable, str(PACKAGE / "install.py"), "--app-home", str(self.app_home), *args, ok=ok)

    def test_check_then_install_and_reject_reinstall(self):
        self.assertIn("No mod files installed", self.installer("--check").stdout)
        self.assertEqual(self.snapshot(), self.original)
        self.assertIn("layout.switch --name main-devvm", self.installer().stdout)
        installed = self.snapshot()
        for path, content in self.original.items():
            self.assertEqual(installed[path], content)
        layout = json.loads(installed[Path("layouts/main-devvm.json")])
        self.assertEqual(layout["body"]["mod"], "devvm-spaces")
        menu = installed[Path("mods/devvm-menu/main.js")]
        self.assertIn(b"modal: true", menu)
        self.assertIn(b"New DevVM Space", menu)
        for name in ("bridge.sh", "host.sh", "devvm.js", "dialog.js"):
            self.assertEqual(installed[Path("mods/devvm-worktree") / name], (PACKAGE / name).read_bytes())
        self.assertIn("Not overwriting", self.installer(ok=False).stderr)
        self.assertEqual(self.snapshot(), installed)

    def test_wrong_app_and_core_versions(self):
        script(self.bin / "hc", 'echo "hc 0.2.0"')
        self.assertIn("0.1.13 or newer", self.installer("--check", ok=False).stderr)
        script(self.bin / "herdr-app", 'echo "herdr-app 0.1.17"')
        self.assertIn("Expected herdr-app 0.1.16", self.installer(ok=False).stderr)
        self.assertEqual(self.snapshot(), self.original)

    def test_patch_drift_leaves_no_partial_files(self):
        (self.app_home / "mods/worktree/main.js").write_text("different source")
        snapshot = self.snapshot()
        self.assertIn("Cannot patch", self.installer(ok=False).stderr)
        self.assertEqual(self.snapshot(), snapshot)

    def test_refuses_dangling_destination_link(self):
        (self.app_home / "mods/devvm-menu").symlink_to(self.root / "missing")
        self.assertIn("Not overwriting", self.installer(ok=False).stderr)
        self.assertTrue((self.app_home / "mods/devvm-menu").is_symlink())
        self.assertFalse((self.app_home / "mods/devvm-spaces").exists())

    def test_source_check_reports_ssh_failure_and_can_retry(self):
        script(self.bin / "ssh", 'echo "Host key verification failed" >&2; exit 255')
        failed = self.installer("--check", "--source", "build-box", ok=False)
        self.assertIn("Host key verification failed", failed.stderr)
        self.assertIn("First-time setup", failed.stderr)
        script(self.bin / "ssh", '''test "$*" != "" && test "$3" = BatchMode=yes && test "$7" = build-box || exit 2
case "$8" in *preflight) printf '/tmp/xdg data/devvm/ssh_config\\n';; *) exit 2;; esac''')
        self.assertIn("Source build-box: basic checks passed", self.installer("--check", "--source", "build-box").stdout)
        self.assertEqual(self.snapshot(), self.original)


class Host(Fixture):
    def host(self, *args, cwd=None, ok=True):
        return self.run_cmd("sh", str(PACKAGE / "host.sh"), *args, cwd=cwd, ok=ok)

    def use_wt(self):
        real = os.environ.get("DEVVM_TEST_WT")
        if real:
            (self.bin / "wt").symlink_to(Path(real).resolve())
        else:
            script(self.bin / "wt", '''if [ "$1" = --version ]; then echo 'wt 0.82.0'; exit; fi
set -eu
[ "$1 $2 $3" = 'switch --no-hooks --no-cd' ]; shift 3
if [ "$1" = --create ]; then
    [ "$2 $3" = '--base @' ]; shift 3
    [ "$1" = --path ]; git worktree add -b "$3" "$2" HEAD
else
    [ "$1" = --path ]; git worktree add "$2" "$3"
fi''')

    def test_preflight_version_failure_has_actionable_message(self):
        script(self.bin / "uname", 'case "$1" in -s) echo Linux;; -m) echo x86_64;; esac')
        script(self.bin / "wt", "echo 'wt 9.9.9'")
        self.assertIn("Expected Worktrunk 0.82.0", self.host("preflight", ok=False).stderr)
        (self.bin / "wt").unlink()
        self.use_wt()
        script(self.bin / "devvm", "echo 0.2.0")
        self.assertIn("Expected DevVM 0.1.0", self.host("preflight", ok=False).stderr)

    def test_invalid_branch_fails_before_worktree_setup(self):
        result = self.host("worktree", "bad branch", "/unused", ok=False)
        self.assertEqual(result.returncode, 64)
        self.assertIn("Enter a valid Git branch name", result.stderr)

    def test_worktree_identities_reuse_and_dirty_detection(self):
        self.use_wt()
        repo1, repo2 = self.root / "one/project", self.root / "two/project"
        for repo in (repo1, repo2):
            repo.mkdir(parents=True)
            self.run_cmd("git", "init", "-b", "main", cwd=repo)
            self.run_cmd("git", "commit", "--allow-empty", "-m", "Initial", cwd=repo)
        legacy = str(self.root / "worktrees/project/topic-one")
        prior = self.host("worktree", "topic/one", legacy, cwd=repo1).stdout.splitlines()
        self.assertEqual(prior[1], "clean")
        (Path(prior[0]) / "local.txt").write_text("keep me")
        other_branch = self.host("worktree", "topic-one", legacy, cwd=repo1).stdout.splitlines()[0]
        other_repo = self.host("worktree", "topic/one", legacy, cwd=repo2).stdout.splitlines()[0]
        self.assertEqual(len({prior[0], other_branch, other_repo}), 3)
        self.assertEqual(self.host("worktree", "topic/one", legacy, cwd=repo1).stdout.splitlines(), [prior[0], "dirty"])
        self.run_cmd("git", "worktree", "add", "-b", "legacy", legacy, cwd=repo1)
        self.assertEqual(self.host("worktree", "legacy", legacy, cwd=repo1).stdout.splitlines(), [legacy, "clean"])


class Bridge(Fixture):
    def test_pinned_loopback_only_and_command_remains_one_argument(self):
        ssh = '''set -eu
if [ "$1" = -G ]; then
    printf 'hostname %s\\nhostkeyalias %s\\nuserknownhostsfile %s\\nport 2222\\n' "$VM_HOST" "$6" "$PIN"
elif [ "$2" = -F ]; then
    printf '%s\\n' "$@"
else
    [ "$7" = source ]; exec sh -c "$8"
fi'''
        script(self.bin / "ssh", ssh)
        script(self.bin / "ssh-keygen", '[ "$*" = "-F $VM -f $PIN" ] && [ "$HAS_PIN" = yes ]')
        vm = "devvm-project-0123456789abcd"
        config = str(self.root / "data ' home/ssh_config")
        pin = f"{Path(config).parent}/vms/0123456789abcd/run/known_hosts"
        self.env.update(VM_HOST="127.0.0.1", PIN=pin, VM=vm, HAS_PIN="no")
        command = "env X='hello world' hc serve"
        args = ("sh", str(PACKAGE / "bridge.sh"), "source", config, vm, command)
        self.assertIn("No pinned host key", self.run_cmd(*args, ok=False).stderr)
        self.env.update(HAS_PIN="yes", VM_HOST="192.0.2.1")
        self.assertIn("No pinned loopback SSH entry", self.run_cmd(*args, ok=False).stderr)
        self.env.update(VM_HOST="127.0.0.1")
        result = self.run_cmd(*args).stdout.splitlines()
        for option in ("StrictHostKeyChecking=yes", "HostName=127.0.0.1", f"HostKeyAlias={vm}",
                       f'UserKnownHostsFile="{pin}"', "GlobalKnownHostsFile=none", "ForwardAgent=no"):
            self.assertIn(option, result)
        self.assertEqual(result[-2:], [vm, command])


if __name__ == "__main__":
    unittest.main()
