import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { checking, theme } from "herdr";
import { checkDevVM, createDevVM, diagnostics, step } from "./devvm.js";

const KEY_CONTEXT = "HerdrDevVMDialog";
const ESCAPE = "herdr_devvm_escape";

export class DevVMDialog {
  constructor(cx, { load, on, close }) {
    this.load = load;
    this.on = on;
    this.close = close;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input = InputState.new({ value: "", placeholder: "branch name" });
    this.input.on("change", (_e, cx) => {
      if (this.failed === "create") this.clearError();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.start("create", cx));
    // In 0.1.16 the outer Overlay Escape action runs before on_key_down.
    // A binding in the deeper dialog context wins, as in the built-in Win98 menu.
    try { cx.bind_keys([{ keystroke: "escape", action: ESCAPE, context: KEY_CONTEXT }]); } catch {}
    if (!checking()) this.start("load", cx);
  }

  escape() {
    if (!this.busy) this.close();
  }

  clearError() {
    this.error = null;
    this.failed = null;
    this.copied = false;
  }

  start(action, cx) {
    if (checking() || this.busy || (action === "create" && !this.repo)) return;
    const branch = this.input.value().trim();
    this.clearError();
    this.context = { Source: this.on(), Repo: this.repo?.cwd, Branch: action === "create" ? branch : "" };
    if (action === "create" && !branch) {
      this.error = new Error("Enter a branch name.");
      cx.notify();
      return;
    }
    this.busy = true;
    this.checked = false;
    this.stage = action === "load" ? "Reading the source repository…" : "Checking setup…";
    this.handle.focus();
    cx.notify();
    cx.spawn(async (cx) => {
      const progress = (stage) => { this.stage = stage; cx.notify(); };
      const options = { on: this.context.Source, context: this.context, progress };
      try {
        if (action === "load") {
          this.repo = await step("Could not read the source repository", "Check that the machine is connected and the space points to a Git checkout. If its terminal moved, return to the repo and reopen the dialog.", this.load);
        } else if (action === "check") {
          await checkDevVM(options);
          this.checked = true;
        } else {
          await createDevVM({ ...options, cwd: this.repo.cwd, path: this.repo.path(branch), branch }, cx);
          this.close();
        }
      } catch (error) {
        this.error = error;
        this.failed = action;
      } finally {
        this.busy = false;
        cx.notify();
        if (this.repo && (action !== "create" || this.error)) cx.timer.after(100, () => { if (!this.busy) this.input.focus(); });
      }
    });
  }

  render() {
    const t = theme();
    const button = (id, label, click) => div().id(id).px(10).py(6).rounded(6).bg(t.raised)
      .border_1().border_color(t.input).text_color(t.foreground).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => click(cx)).child(label);
    return v_flex().id("devvm-dialog").size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .key_context(KEY_CONTEXT).on_action(ESCAPE, () => this.escape()).track_focus(this.handle)
      .child(div().font_semibold().text_color(t.foreground).child("New DevVM Space"))
      .child(div().text_color(t.muted).child("Create a linked worktree and open its clone in a DevVM guest. Uncommitted files stay on the host."))
      .when(this.repo && !this.busy, (el) => el.child(Input.new(this.input).h(32).px(10).items_center().rounded(6)
        .border_1().border_color(t.input).bg(t.background).text_color(t.foreground)))
      .when(this.busy, (el) => el.child(div().text_color(t.accent).child(this.stage))
        .child(div().text_color(t.dim).child("Leave the dialog open. First boot can take several minutes.")))
      .when(this.checked, (el) => el.child(div().text_color(t.accent).child("Basic setup check passed. This check does not start a VM.")))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error.message ?? String(this.error)))
        .when(Boolean(this.error.advice), (el) => el.child(div().text_color(t.muted).child(this.error.advice))))
      .child(div().flex_1())
      .when(!this.busy, (el) => el
        .child(div().text_size(11).text_color(t.dim).child(this.failed
          ? "Review copied details before sharing. They can include host names and paths."
          : "Create may install Herdr Core in the guest. It does not install DevVM."))
        .child(h_flex().justify_end().gap(8).text_size(12)
          .when(this.failed, (row) => row.child(button("devvm-copy", this.copied ? "Copied" : "Copy details", (cx) => {
            cx.write_to_clipboard(diagnostics(this.error, this.context));
            this.copied = true;
            cx.notify();
          })))
          .child(button("devvm-close", "Close", () => this.escape()))
          .when(this.repo && this.failed !== "check", (row) => row.child(button("devvm-check", "Check setup", (cx) => this.start("check", cx))))
          .when(this.failed, (row) => row.child(button("devvm-retry", "Retry", (cx) => this.start(this.failed, cx))))
          .when(this.repo && this.failed !== "create", (row) => row.child(button("devvm-create", "Create", (cx) => this.start("create", cx))))));
  }
}
