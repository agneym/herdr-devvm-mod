import { appHome, checking, exec, machines, notify, readTextFile, run, spaces, window } from "herdr";

const CORE_RANGE = "0.1.x (0.1.13 or newer)";
const supportedCore = (version) => Number(/^0\.1\.(\d+)$/.exec(version)?.[1]) >= 13;
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const absolute = (value) => value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value);
const shortOutput = (value) => {
  const text = String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim();
  return text.length > 4000 ? `${text.slice(0, 1700)}\n[… output shortened …]\n${text.slice(-2100)}` : text;
};

function checked(result) {
  if (result.code === 0) return (result.stdout ?? "").replace(/\n$/, "");
  const output = [shortOutput(result.stdout), shortOutput(result.stderr)].filter(Boolean).join("\n");
  throw new Error(`Exit code ${result.code}${output ? `\n${output}` : ""}`);
}

// Keep the dialog message short. Put process output and retry context on the clipboard only on request.
export async function step(title, advice, task) {
  try { return await task(); }
  catch (error) {
    const failure = new Error(error.publicMessage ?? title);
    failure.advice = error.publicAdvice ?? advice;
    failure.details = shortOutput(error.message ?? error);
    throw failure;
  }
}

export function diagnostics(error, context) {
  return ["Herdr DevVM · App 0.1.16 / DevVM 0.1.0",
    ...Object.entries(context).filter(([, value]) => value).map(([key, value]) => `${key}: ${shortOutput(value)}`),
    "", error.message, error.advice, error.details].filter((value) => value !== undefined).join("\n");
}

const localHc = (args, timeout = 30_000) => exec("hc", args, { timeout });
async function listMachines() {
  const { machines } = JSON.parse(checked(await localHc(["machine", "ls", "--json"])));
  if (!Array.isArray(machines)) throw new Error("Herdr did not return a machine list.");
  return machines;
}

async function until(cx, lookup, message) {
  const end = Date.now() + 25_000;
  for (;;) {
    const value = lookup();
    if (value) return value;
    if (Date.now() >= end) throw new Error(message);
    await new Promise((resolve) => cx.timer.after(250, () => resolve()));
  }
}

export async function checkDevVM({ on, progress, context }) {
  if (checking()) throw new Error("DevVM setup is disabled during a mod check.");
  progress(on ? "Checking Herdr and the SSH host…" : "Checking Herdr and the local host…");
  const source = await step("Could not check the Herdr source machine", "Use a local checkout or a connected macOS or Linux machine added by SSH target, not --via. Check Settings → Machines and the Core versions.", async () => {
    if (!["linux", "macos"].includes(window()?.platform)) throw new Error("Use a macOS or Linux desktop.");
    const version = checked(await localHc(["--version"])).trim();
    context["Desktop Core"] = version;
    if (!version.startsWith("hc ") || !supportedCore(version.slice(3))) throw new Error(`Expected hc ${CORE_RANGE} on the desktop; found ${version}.`);
    if (!on) {
      context.Source = "Local checkout";
      return null;
    }
    const machine = (await listMachines()).find((entry) => entry?.name === on);
    if (!machine || machine.via || !machine.target || !/^[0-9a-f]{12,}$/.test(machine.id ?? "") || /[\s\x00-\x1f\x7f]/.test(machine.target) || machine.target.startsWith("-")) {
      throw new Error("Add the source machine to Herdr using a regular SSH target.");
    }
    context.Target = machine.target;
    if (machine.state !== "connected") throw new Error(`Source machine is ${machine.state ?? "not connected"}. ${machine.why ?? ""}`);
    context["Source Core"] = machine.version;
    if (!supportedCore(machine.version)) throw new Error(`Expected hc ${CORE_RANGE} on the source; found ${machine.version ?? "unknown"}.`);
    return machine;
  });

  const mod = `${appHome()}/mods/devvm-worktree`;
  const script = await step("Could not read the DevVM helper", "Check that the mod is installed in this app home. See the README for reinstall steps.", async () => {
    const text = await readTextFile(`${mod}/host.sh`);
    if (!text) throw new Error("Missing host.sh in devvm-worktree.");
    return text;
  });
  const hostArgs = (args) => ["-c", script, "herdr-devvm", ...args];
  // For VM boot, bypass hc exec's child cleanup: run locally or over SSH.
  const runHost = (args, timeout) => {
    if (!source) return exec("sh", hostArgs(args), { timeout });
    const remote = ["sh", ...hostArgs(args)].map(quote).join(" ");
    return exec("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", source.target, remote], { timeout });
  };
  const adapter = await step("Invalid DevVM worktree adapter setting", "Set worktrees.devvmAdapter in settings.json to an absolute executable path on the source host, or omit it to use Git.", async () => {
    const raw = await readTextFile(`${appHome()}/settings.json`);
    const path = (raw === null ? {} : JSON.parse(raw))?.worktrees?.devvmAdapter;
    if (path === undefined) return "";
    if (typeof path !== "string" || !absolute(path)) throw new Error("worktrees.devvmAdapter must be an absolute path.");
    return path;
  });
  const config = await step(source ? "SSH host setup check failed" : "Local host setup check failed", source
    ? "Copy details for the cause. Check batch SSH from the desktop and run devvm doctor on the source host."
    : "Copy details for the cause and run devvm doctor on this computer. See First-time setup in the README.", async () => {
    const path = checked(await runHost(["preflight", adapter], 30_000));
    if (!absolute(path)) throw new Error("Invalid DevVM SSH config path. Check XDG_DATA_HOME and remove extra stdout from SSH shell startup.");
    return path;
  });
  return { source, mod, hostArgs, runHost, config, adapter };
}

export async function createDevVM({ on, cwd, branch, path, progress, context }, cx) {
  const { source, mod, hostArgs, runHost, config, adapter } = await checkDevVM({ on, progress, context });

  progress("Preparing the worktree…");
  const folder = await step("Worktree setup failed", "Check the branch and worktree path in the details. Use a new branch if the requested branch is checked out elsewhere. The mod does not remove checkouts.", async () => {
    const result = await exec("sh", hostArgs(["worktree", branch, path, adapter]), { on, cwd, timeout: 600_000 });
    let out;
    try { out = checked(result); }
    catch (error) {
      if (result.code === 64) {
        error.publicMessage = "Invalid Git branch name";
        error.publicAdvice = "Use a branch name such as feature/my-change. Do not use spaces or start with a dash.";
      }
      throw error;
    }
    const [folder, status, extra] = out.split("\n");
    if (!absolute(folder) || !["clean", "dirty"].includes(status) || extra !== undefined) throw new Error("Invalid worktree result.");
    context.Worktree = folder;
    if (status === "dirty") {
      context.Checkout = "Dirty. Uncommitted and untracked files stay on the source host.";
      notify({ title: "Host worktree has local changes", body: "DevVM 0.1.0 does not copy uncommitted or untracked files. The changes stay on the source host.", level: "warning" });
    }
    return folder;
  });

  progress("Starting DevVM and copying the checkout…");
  const { vm, vmId } = await step("DevVM setup failed", "The worktree stays on the host. Check the DevVM output and devvm ls there. If DevVM needs input or more time, run devvm --clone in that worktree, exit its shell, then retry this branch.", async () => {
    const { vms } = JSON.parse(checked(await runHost(["boot", folder], 600_000)));
    const vm = vms?.find((entry) => entry?.folder === folder && entry.status === "Running" && entry.git === "clone");
    const vmId = /^devvm-[a-z0-9-]+-([a-f0-9]{14})$/.exec(vm?.name ?? "")?.[1];
    if (!vmId) throw new Error("DevVM did not report a running clone for this worktree.");
    context.VM = vm.name;
    return { vm, vmId };
  });

  progress("Connecting Herdr to the guest…");
  const via = ["/bin/sh", `${mod}/bridge.sh`, source?.target ?? "", config, vm.name].map(quote).join(" ");
  const name = `vm-${source ? source.id.slice(0, 12) : "local"}-${vmId}`;
  const match = (machine) => machine?.via && machine.target === via && !machine.temporary;
  const guest = await step("Could not register the DevVM guest", "Check Settings → Machines and the copied SSH error. If the guest pin is missing or mismatched, check the VM on the source host. Do not disable the host key checks.", async () => {
    const entries = await listMachines();
    const existing = entries.find(match);
    if (existing?.name) return existing;
    if (entries.some((machine) => machine?.name === name)) throw new Error(`Machine ${name} exists with a different connection. Inspect it in Settings → Machines. The mod will not replace it.`);
    // Temporary machines do not get layout documents in Herdr 0.1.16.
    const added = JSON.parse(checked(await localHc(["machine", "add", "--json", "--install", "--name", name, "--via", via], 120_000)));
    if (added?.name !== name || !match(added)) throw new Error("Herdr did not return the expected guest registration.");
    return added;
  });
  context.Guest = guest.name;
  await step("Guest layout is not ready", "Check the guest under Settings → Machines. When it connects, retry the same branch. The registration is kept.", () =>
    until(cx, () => machines().some((m) => m.name === guest.name && m.layout === "ready"), `Timed out waiting for ${guest.name}.`));

  progress("Opening the guest space…");
  await step("Could not open the guest space", "Check herdr-app status and Settings → Machines. Retry the same branch to open or select the guest space.", async () => {
    const findSpace = () => spaces().find((space) => space.machine === guest.name && space.folder === folder);
    const existing = findSpace();
    if (existing) run("space.select", { id: existing.id });
    else {
      run("space.new", { name: `${branch} · DevVM`, machine: guest.name, folder });
      await until(cx, findSpace, `Timed out waiting for a space on ${guest.name}.`);
    }
  });
}
