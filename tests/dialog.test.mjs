import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Load the actual mod code with small stubs for Herdr's native JS modules.
const url = (code) => `data:text/javascript,${encodeURIComponent(code)}`;
const stub = (name, exports) => url(`export const { ${exports} } = globalThis.${name};`);
const herdr = stub("herdrFixture", "appHome, checking, exec, machines, notify, readTextFile, run, spaces, theme, window");
const kit = stub("kitFixture", "div");
const base = stub("kitFixture", "h_flex, v_flex, InputState, Input");
let fx;
globalThis.herdrFixture = {
  appHome: () => "/app with spaces", checking: () => Boolean(fx.checking), exec: (...args) => fx.exec(...args),
  machines: () => fx.ready ? fx.guests.map((g) => ({ name: g.name, layout: "ready" })) : [],
  notify: (notice) => fx.notices.push(notice), readTextFile: async () => "# helper fixture",
  run: (name, args) => {
    fx.actions.push({ name, args });
    if (name === "space.new" && fx.openSpace) fx.spaces.push({ ...args, id: "vm/space" });
  },
  spaces: () => fx.spaces, theme: () => ({}), window: () => ({ platform: "linux" }),
};
const element = () => {
  const node = { children: [], actions: {} };
  const builder = new Proxy(node, { get(target, key) {
    return key in target ? target[key] : (...args) => {
      if (key === "id") node.name = args[0];
      if (key === "child") node.children.push(args[0]);
      if (key === "when" && args[0]) args[1](builder);
      if (key === "on_click") node.click = args[0];
      if (key === "on_action") node.actions[args[0]] = args[1];
      return builder;
    };
  } });
  return builder;
};
globalThis.kitFixture = {
  div: element, h_flex: element, v_flex: element, Input: { new: element },
  InputState: { new: ({ value }) => ({ text: value, value() { return this.text; }, on() {}, focus() {} }) },
};
const source = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const devvmURL = url((await source("devvm.js")).replace('"herdr"', JSON.stringify(herdr)));
const { DevVMDialog } = await import(url((await source("dialog.js"))
  .replace('"herdr"', JSON.stringify(herdr)).replace('"gpui-kit"', JSON.stringify(kit))
  .replace('"gpui-base"', JSON.stringify(base)).replace('"./devvm.js"', JSON.stringify(devvmURL))));

const folder = "/worktrees/project-0123/branch-4567";
const vm = "devvm-feature-0123456789abcd";
const ok = (data) => ({ code: 0, stdout: typeof data === "string" ? data : JSON.stringify(data), stderr: "" });
const bad = (stderr) => ({ code: 1, stdout: "", stderr });

function fixture() {
  fx = {
    source: { name: "source", target: "build-box", id: "abcdef1234567890", version: "0.1.20", state: "connected" },
    ready: true, openSpace: true, tasks: [], actions: [], notices: [], guests: [], spaces: [], ops: [],
    async exec(cmd, args, options) {
      if (cmd === "hc" && args[0] === "--version") return ok("hc 0.1.21\n");
      if (cmd === "hc" && args[1] === "ls") return ok({ machines: [this.source, ...this.guests] });
      if (cmd === "ssh" && args.at(-1).endsWith("'preflight'")) {
        this.ops.push("preflight");
        assert.equal(args.at(-2), this.source.target);
        assert.ok(args.includes("BatchMode=yes"));
        if (this.badSSH) throw new Error("Permission denied (publickey).");
        return ok("/source data/devvm/ssh_config\n");
      }
      if (cmd === "sh" && args[3] === "worktree") {
        this.ops.push("worktree");
        assert.equal(options.on, "source");
        if (args[4] === "bad branch") return { ...bad("raw validation output from host"), code: 64 };
        assert.equal(args[4], "topic/one");
        return ok(`${folder}\ndirty\n`);
      }
      if (cmd === "ssh" && args.at(-1).endsWith(`'boot' '${folder}'`)) {
        this.ops.push("boot");
        if (this.bootError) return bad("\u001b[31mImage download failed\u001b[0m\nSee /source/devvm/build.log");
        return ok({ vms: [{ name: vm, folder: this.wrongFolder ?? folder, status: "Running", git: "clone" }] });
      }
      if (cmd === "hc" && args[1] === "add") {
        this.ops.push("add");
        assert.ok(args.includes("--install"));
        assert.ok(!args.includes("--temp"));
        const name = args[args.indexOf("--name") + 1];
        const target = args[args.indexOf("--via") + 1];
        assert.ok(target.includes(`'/app with spaces/mods/devvm-worktree/bridge.sh' '${this.source.target}' '/source data/devvm/ssh_config'`));
        if (this.badPin) return bad("DevVM SSH: No pinned host key");
        const guest = { name, target, via: true, temporary: false };
        this.guests.push(guest);
        return ok(guest);
      }
      assert.fail(`Unexpected command: ${cmd} ${args}`);
    },
  };
  const cx = {
    focus_handle: () => ({ focus() {} }), bind_keys: (keys) => { fx.keys = keys; }, notify() {},
    spawn: (task) => fx.tasks.push(task(cx)), timer: { after(_ms, task) { task(); } },
    write_to_clipboard: (text) => { fx.clipboard = text; },
  };
  const open = () => new DevVMDialog(cx, {
    on: () => "source", load: async () => {
      if (fx.loadError) throw new Error("source session offline");
      return { cwd: "/source/project", path: () => "/worktrees/project/topic-one" };
    }, close: () => { fx.closed = (fx.closed ?? 0) + 1; },
  });
  const settled = async () => { while (fx.tasks.length) await fx.tasks.shift(); };
  const find = (node, id) => node.name === id ? node : node.children.filter((n) => typeof n !== "string").map((child) => find(child, id)).find(Boolean);
  const click = (dialog, id) => { const button = find(dialog.render(), `devvm-${id}`); assert.ok(button, id); button.click(null, cx); };
  const start = async () => { const dialog = open(); await settled(); dialog.input.text = "topic/one"; return dialog; };
  return { click, open, settled, start };
}

test("retry source discovery; Check setup runs no worktree, guest or space action", async () => {
  const { click, open, settled } = fixture();
  fx.loadError = true;
  const dialog = open();
  await settled();
  assert.equal(dialog.error.message, "Could not read the source repository");
  click(dialog, "copy");
  assert.match(fx.clipboard, /source session offline/);
  fx.loadError = false;
  click(dialog, "retry");
  await settled();
  click(dialog, "check");
  await settled();
  assert.equal(dialog.checked, true);
  assert.deepEqual(fx.ops, ["preflight"]);
  assert.deepEqual(fx.actions, []);
});

test("batch SSH error stays in the dialog; copy rejection, then retry the same branch", async () => {
  const { click, start, settled } = fixture();
  const dialog = await start();
  fx.badSSH = true;
  click(dialog, "create");
  await settled();
  assert.equal(dialog.error.message, "SSH host setup check failed");
  assert.deepEqual(fx.ops, ["preflight"]);
  assert.equal(fx.closed, undefined);
  click(dialog, "copy");
  assert.match(fx.clipboard, /Branch: topic\/one/);
  assert.match(fx.clipboard, /Permission denied/);
  fx.badSSH = false;
  click(dialog, "retry");
  await settled();
  assert.equal(fx.closed, 1);
  assert.deepEqual(fx.ops, ["preflight", "preflight", "worktree", "boot", "add"]);
});

test("invalid branch shows a safe inline message and keeps raw text behind Copy details", async () => {
  const { click, start, settled } = fixture();
  const dialog = await start();
  dialog.input.text = "bad branch";
  click(dialog, "create");
  await settled();
  assert.equal(dialog.error.message, "Invalid Git branch name");
  const text = (node) => typeof node === "string" ? node : node.children.map(text).join("\n");
  assert.doesNotMatch(text(dialog.render()), /raw validation output/);
  click(dialog, "copy");
  assert.match(fx.clipboard, /raw validation output/);
  assert.deepEqual(fx.ops, ["preflight", "worktree"]);
  dialog.input.text = "topic/one";
  click(dialog, "retry");
  await settled();
  assert.equal(fx.closed, 1);
});

test("busy Escape uses a deeper action and ignores dismissal or duplicate starts", async () => {
  const { click, start, settled } = fixture();
  const dialog = await start();
  fx.bootError = true;
  click(dialog, "create");
  const [binding] = fx.keys;
  assert.equal(binding.context, "HerdrDevVMDialog");
  assert.equal(binding.keystroke, "escape");
  const escape = dialog.render().actions[binding.action];
  escape();
  assert.equal(fx.closed, undefined);
  assert.equal(findBusyClose(dialog), false);
  dialog.start("create", {}); // A duplicate event must not start another task.
  assert.equal(fx.tasks.length, 1);
  await settled();
  escape();
  assert.equal(fx.closed, 1);
});

function findBusyClose(dialog) {
  const all = (node) => [node.name, ...node.children.filter((n) => typeof n !== "string").flatMap(all)];
  return all(dialog.render()).includes("devvm-close");
}

test("boot failure, pinned SSH failure, then reopen and reuse the same guest space", async () => {
  const { click, start, settled } = fixture();
  const dialog = await start();
  fx.bootError = true;
  click(dialog, "create");
  await settled();
  assert.equal(dialog.error.message, "DevVM setup failed");
  click(dialog, "copy");
  assert.match(fx.clipboard, /Worktree: .*project/);
  assert.match(fx.clipboard, /build.log/);
  assert.doesNotMatch(fx.clipboard, /\u001b/);
  assert.equal(fx.notices[0].level, "warning");
  assert.equal(fx.guests.length, 0);
  fx.bootError = false;
  fx.badPin = true;
  click(dialog, "retry");
  await settled();
  click(dialog, "copy");
  assert.match(fx.clipboard, /No pinned host key/);
  assert.equal(fx.actions.length, 0);
  fx.badPin = false;
  click(dialog, "close");
  const reopened = await start();
  click(reopened, "create");
  await settled();
  assert.equal(fx.guests[0].name, "vm-abcdef123456-0123456789abcd");
  const again = await start();
  click(again, "create");
  await settled();
  assert.equal(fx.guests.length, 1);
  assert.deepEqual(fx.actions.map(({ name }) => name), ["space.new", "space.select"]);
});

test("layout timeout keeps registration; retry waits for the same guest", async () => {
  const { click, start, settled } = fixture();
  const dialog = await start();
  fx.ready = false;
  const now = Date.now;
  let fake = 0;
  try {
    Date.now = () => fake += 26_000;
    click(dialog, "create");
    await settled();
  } finally { Date.now = now; }
  assert.equal(dialog.error.message, "Guest layout is not ready");
  assert.equal(fx.guests.length, 1);
  assert.equal(fx.actions.length, 0);
  fx.ready = true;
  click(dialog, "retry");
  await settled();
  assert.equal(fx.ops.filter((op) => op === "add").length, 1);
  assert.equal(fx.actions[0].name, "space.new");
});

test("different hosts with the same VM name and folder get distinct registrations", async () => {
  const { click, start, settled } = fixture();
  click(await start(), "create");
  await settled();
  fx.source = { ...fx.source, id: "123456abcdef1234", target: "another-box" };
  click(await start(), "create");
  await settled();
  assert.deepEqual(fx.guests.map((guest) => guest.name), ["vm-abcdef123456-0123456789abcd", "vm-123456abcdef-0123456789abcd"]);
  assert.equal(fx.spaces.length, 2);
});

test("a different VM folder is refused before guest registration", async () => {
  const { click, start, settled } = fixture();
  const dialog = await start();
  fx.wrongFolder = "/a-different-checkout";
  click(dialog, "create");
  await settled();
  assert.equal(dialog.error.message, "DevVM setup failed");
  assert.equal(fx.guests.length, 0);
});

test("mod check does not run source discovery or creation", async () => {
  const { open, settled } = fixture();
  fx.checking = true;
  const dialog = open();
  await settled();
  assert.equal(dialog.repo, undefined);
  assert.deepEqual(fx.ops, []);
});
