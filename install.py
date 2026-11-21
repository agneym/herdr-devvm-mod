#!/usr/bin/env python3
"""Install or check the DevVM layout for Herdr App 0.1.16."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile


VERSION = "herdr-app 0.1.16"
LAYOUT = "main-devvm"
BUNDLE = Path(__file__).resolve().parent
HELPERS = ("bridge.sh", "host.sh", "devvm.js", "dialog.js")


def replace(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Expected one match for {old!r}. Check the installed app version.")
    return text.replace(old, new, 1)


def update_layout(value):
    if isinstance(value, dict):
        if value.get("mod") == "spaces":
            value["mod"] = "devvm-spaces"
            return 1
        return sum(update_layout(item) for item in value.values())
    if isinstance(value, list):
        return sum(update_layout(item) for item in value)
    return 0


def patch_spaces(text):
    return replace(text, 'mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space"',
                   'mod: "devvm-menu", kind: "popup", width: 220, height: 280, props: { tab: "space"')


def patch_menu(text):
    text = replace(text, 'spaces, panes, exec } from "herdr";', 'spaces, panes, exec, window } from "herdr";')
    marker = '        ...(git === "linked" ? [["Remove worktree"'
    return replace(
        replace(text, marker, '''        ...(git && window()?.platform !== "windows" && spaces().find((s) => s.id === tg.id)?.machine
          ? [["New DevVM Space…", "devvm-worktree", { space: tg.id, action: "devvm" }]] : []),
''' + marker),
        '    else run(it[1], it[2]);',
        '''    else if (it[1] === "devvm-worktree") openOverlay({ mod: "devvm-worktree", kind: "dialog", modal: true, width: 560, height: 360, props: it[2] });
    else run(it[1], it[2]);''',
    )


def patch_worktree(text):
    marker = 'import { View, div } from "gpui-kit";'
    text = replace(text, marker, 'import { DevVMDialog } from "./dialog.js";\n' + marker)
    marker = '    this.on = this.space()?.machine;'
    text = replace(text, marker, marker + '''
    if (props()?.action === "devvm") {
      this.devvm = new DevVMDialog(cx, {
        on: () => this.on,
        close: () => this.close(),
        load: async () => {
          if (!this.on) throw new Error("Open this dialog from a Linux SSH space.");
          const result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on });
          const userHome = result.stdout.trim();
          if (result.code !== 0 || !userHome.startsWith("/")) throw new Error(result.stderr || "Could not read the source host home folder.");
          const folder = place(this.space());
          if (!folder) throw new Error("No folder in the source space.");
          const repo = await repoOf(folder, this.on);
          if (!repo) throw new Error(`Could not read a Git checkout at ${folder}. Check Git and the terminal folder.`);
          const directory = await root(userHome);
          if (directory && !directory.startsWith("/")) throw new Error("worktrees.directory must be a Linux absolute path or start with ~/.");
          return { cwd: repo.top, path: (branch) => `${directory}/${repo.name}/${slug(branch)}` };
        },
      });
      return;
    }''')
    return replace(text, '  render(cx) {', '  render(cx) {\n    if (this.devvm) return this.devvm.render();')


def prepare(home):
    for name in ("layouts", "mods"):
        folder = home / name
        if folder.is_symlink() or not folder.is_dir():
            raise ValueError(f"Expected a real directory at {folder}. Open Herdr 0.1.16 once with this app home.")
    layout = json.loads((home / "layouts/main.json").read_text(encoding="utf-8"))
    if not isinstance(layout, dict) or update_layout(layout) != 1:
        raise ValueError("Expected one built-in Spaces sidebar in layouts/main.json. Restore the shipped 0.1.16 layout first.")
    layout["cloned_from"] = {"name": "main", "version": "0.1.16"}
    sources = {}
    for name, patch in {"spaces": patch_spaces, "menu": patch_menu, "worktree": patch_worktree}.items():
        source = home / "mods" / name
        entry = source / "main.js"
        if not (source / "mod.json").is_file() or not entry.is_file():
            raise ValueError(f"Missing shipped mod files in {source}. Open Herdr 0.1.16 with this app home first.")
        try:
            sources[source] = patch(entry.read_text(encoding="utf-8")).replace(f"mods/{name}/", f"mods/devvm-{name}/")
        except ValueError as error:
            raise ValueError(f"Cannot patch {entry}. {error} Use the shipped, unedited 0.1.16 mod.") from error
    for name in HELPERS:
        if not (BUNDLE / name).is_file():
            raise ValueError(f"Package file missing: {BUNDLE / name}. Get a complete copy of this package.")
    return layout, sources


def install(home, layout_path, layout, sources):
    with tempfile.TemporaryDirectory(prefix=".devvm-install-", dir=home) as staging:
        stage = Path(staging)
        for source, text in sources.items():
            dest = stage / f"devvm-{source.name}"
            shutil.copytree(source, dest)
            (dest / "main.js").write_text(text, encoding="utf-8")
        for name in HELPERS:
            shutil.copyfile(BUNDLE / name, stage / "devvm-worktree" / name)
        staged_layout = stage / layout_path.name
        staged_layout.write_text(json.dumps(layout, indent=2) + "\n", encoding="utf-8")
        made = []
        try:
            for source in sources:
                dest = home / "mods" / f"devvm-{source.name}"
                dest.mkdir()  # Refuse an existing destination, including one made after preflight.
                made.append(dest)
                shutil.copytree(stage / dest.name, dest, dirs_exist_ok=True)
            os.link(staged_layout, layout_path)  # Publish last, with no overwrite.
        except OSError:
            for dest in reversed(made):
                shutil.rmtree(dest)
            raise


def version(program):
    try:
        result = subprocess.run([program, "--version"], capture_output=True, text=True, timeout=10, check=True)
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(f"Could not run {program} --version. Check the executable path. ({error})") from error


def source_adapter(home):
    try:
        settings = json.loads((home / "settings.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return ""
    worktrees = settings.get("worktrees") if isinstance(settings, dict) else None
    if not isinstance(worktrees, dict) or "devvmAdapter" not in worktrees:
        return ""
    path = worktrees["devvmAdapter"]
    if not isinstance(path, str) or not path.startswith("/") or re.search(r"[\x00-\x1f\x7f]", path):
        raise ValueError("worktrees.devvmAdapter must be an absolute executable path on the Linux source host.")
    return path


def check_source(target, adapter):
    if not target or target.startswith("-") or re.search(r"[\s\x00-\x1f\x7f]", target):
        raise ValueError("Pass one SSH alias or user@host with --source. Put any options in SSH config.")
    script = (BUNDLE / "host.sh").read_text(encoding="utf-8")
    remote = shlex.join(["sh", "-c", script, "herdr-devvm", "preflight", adapter])
    try:
        result = subprocess.run(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target, remote],
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("Could not run the SSH host check. Verify that ssh -o BatchMode=yes TARGET true works from this desktop.") from error
    if result.stderr:
        print(result.stderr.rstrip(), file=sys.stderr)
    if result.returncode != 0:
        raise ValueError("Source host check failed. Fix the SSH or dependency error above. See First-time setup in README.md.")
    config = result.stdout.removesuffix("\n")
    if not config.startswith("/") or re.search(r"[\x00-\x1f\x7f]", config):
        raise ValueError("Invalid DevVM SSH config path. Check XDG_DATA_HOME and remove extra stdout from SSH shell startup.")
    print(f"Source {target}: basic checks passed (DevVM SSH config: {config}). Run devvm doctor on the host for a full backend check.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    parser.add_argument("--app-home", type=Path, default=Path(os.environ.get("HERDR_APP_HOME") or config / "herdr-app"))
    parser.add_argument("--app", default="herdr-app", help="Path to the desktop app CLI")
    parser.add_argument("--check", action="store_true", help="Check setup without installing the mod")
    parser.add_argument("--core", default="hc", help="Core CLI to check with --check (does not contact the daemon)")
    parser.add_argument("--source", help="Also check this SSH target with --check")
    args = parser.parse_args()
    if args.source is not None and not args.check:
        parser.error("--source requires --check")
    try:
        if sys.platform not in ("linux", "darwin"):
            raise ValueError("Use a Linux or macOS desktop.")
        installed = version(args.app)
        if installed != VERSION:
            raise ValueError(f"Expected {VERSION}; found {installed!r}. Pass --app with the path to Herdr App 0.1.16.")
        home = args.app_home.expanduser().resolve()
        layout, sources = prepare(home)
        layout_path = home / "layouts" / f"{LAYOUT}.json"
        for dest in [layout_path, *(home / "mods" / f"devvm-{p.name}" for p in sources)]:
            if dest.exists() or dest.is_symlink():
                message = f"Not overwriting {dest}. See the README for reinstall steps."
                if not args.check:
                    raise ValueError(message)
                print(message)
        if args.check:
            core = version(args.core)
            match = re.fullmatch(r"hc 0\.1\.(\d+)", core)
            if not match or int(match[1]) < 13:
                raise ValueError(f"Expected hc 0.1.x (0.1.13 or newer); found {core!r}. Pass --core with the path to the app's Core CLI.")
            print(f"Desktop: {VERSION}, {core}, and shipped layout/mods checked at {home}.")
            if args.source is not None:
                check_source(args.source, source_adapter(home))
            print("Check complete. No mod files installed and no VM started.")
        else:
            install(home, layout_path, layout, sources)
            print(f"Installed the DevVM layout in {home}.")
            print(f"Switch the open app: {shlex.join([args.app, 'do', 'layout.switch', '--name', LAYOUT])}")
    except (OSError, ValueError) as error:
        parser.exit(1, f"{'Check' if args.check else 'Install'} failed: {error}\n")


if __name__ == "__main__":
    main()
