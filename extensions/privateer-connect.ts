/**
 * The Privateer `/connect` panel — add, toggle, and remove MCP connectors without
 * leaving the terminal.
 *
 * WHY THIS EXISTS: pi-mcp-adapter owns `/mcp`, but that command is a *status and
 * connection* surface — its setup flow can only adopt configs from other hosts,
 * scaffold an EMPTY `.mcp.json`, or quick-add RepoPrompt. There is no way to type in
 * a server. So the terminal was the one surface where adding a connector meant
 * hand-editing JSON, while the phone and the desktop both had a real editor.
 *
 * ONE CONFIG, THREE SURFACES: this is deliberately a thin UI over the SAME
 * makeMcpControl() the relay uses (src/remote/mcpControl.ts) — which is why that
 * module was written framework-agnostic. A connector added here lands in
 * `agent/mcp-desktop.json` and is projected into `agent/mcp.json`, so it shows up in
 * the app's MCP screen, survives a toggle from the phone, and is read by the harbor's
 * routine runs. Nothing about this panel is terminal-specific except the pixels.
 *
 * SECRETS: env values are typed into a masked field and written in PLAINTEXT to the
 * config on this machine — correct, and the same thing the desktop does: the adapter
 * has to hand the real token to the server process. The masking is shoulder-surfing
 * and screen-share hygiene, not a storage claim. (Over the relay it's different —
 * there the value is sealed to the terminal's key; see mcpControl's header.)
 */
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import {
  makeMcpControl,
  type McpDraft,
  type RemoteMcpServer,
} from "../src/remote/mcpControl.ts";
import {
  MCP_CATALOG,
  draftFromCatalog,
  promptOrder,
  type CatalogEntry,
} from "../src/mcp/catalog.ts";

// Minimal views of Pi's theme + TUI handle, mirroring privateer-models.ts — enough to
// color text and request a redraw without coupling this file to Pi internals.
interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}
interface TuiLike {
  requestRender(): void;
}

// What the panel hands back to the command handler when it closes.
export interface ConnectResult {
  // True when the config changed, so the handler knows to reload the adapter.
  changed: boolean;
  message?: string;
}

const MAX_VISIBLE = 10;

// ---------------------------------------------------------------------------
// A masked single-line field for credentials.
//
// pi-tui's Input has no mask and keeps `value` private, so a subclass can't render
// dots without breaking the cursor. A token field only needs insert / backspace /
// clear / paste, so we own those few keys directly and render the dots ourselves.
// ---------------------------------------------------------------------------
class SecretField {
  value = "";

  // Returns true when the keystroke was consumed. Escape sequences (arrows, F-keys)
  // are swallowed rather than inserted — the naive "strip control chars" approach
  // would leave "[A" behind from an up-arrow and silently corrupt the token.
  handleInput(data: string): boolean {
    // A PASTE MUST BE UNWRAPPED FIRST. pi-tui's Terminal re-wraps pasted text in
    // bracketed-paste markers and delivers it as ONE chunk (`\x1b[200~…\x1b[201~`,
    // see pi-tui terminal.ts) — which starts with ESC, so the arrow-key guard below
    // would otherwise swallow the entire token and leave the field empty.
    const paste = /^\x1b\[200~([\s\S]*?)\x1b\[201~$/.exec(data);
    if (paste) {
      // Control chars (a trailing newline from the clipboard, most often) are stripped
      // the same way typed input is — a token never legitimately contains one.
      this.value += paste[1].replace(/[\x00-\x1f\x7f]/g, "");
      return true;
    }
    if (data.startsWith("\x1b")) return true;
    if (data === "\x7f" || data === "\b") {
      this.value = this.value.slice(0, -1);
      return true;
    }
    if (data === "\x15") {
      // ctrl+U — clear the field
      this.value = "";
      return true;
    }
    // Ordinary typed input (pastes took the branch above).
    const printable = data.replace(/[\x00-\x1f\x7f]/g, "");
    if (!printable) return false;
    this.value += printable;
    return true;
  }

  // Dots, capped so a long PAT can't wrap the panel. Length is intentionally NOT
  // exact past the cap — it isn't information the user needs, and it leaks the
  // token's length to anyone watching.
  display(): string {
    if (!this.value) return "";
    return "•".repeat(Math.min(this.value.length, 32));
  }
}

// ---------------------------------------------------------------------------
// The wizard's steps. A catalog entry expands into zero or more of these; a custom
// or edited connector into three. Keeping the form as a flat step list (rather than
// a focus-managed multi-field form) means one Input on screen at a time, which is
// both simpler to drive with a keyboard and simpler to reason about.
// ---------------------------------------------------------------------------
interface Step {
  key: string;
  prompt: string;
  hint?: string;
  secret?: boolean;
  initial?: string;
  // A step that may be submitted empty. For an edit, an empty secret means "keep
  // the value already on disk" — mcpControl's env merge rule makes that free.
  optional?: boolean;
}

type View = "list" | "catalog" | "form";

// A pending save: the steps still to collect plus how to turn the answers into a
// draft once they're all in.
interface Pending {
  title: string;
  steps: Step[];
  build(answers: Record<string, string>): McpDraft;
  // Where esc from the FIRST step returns to. Carried explicitly rather than inferred
  // from the title — an edit and a fresh add can look identical on screen.
  origin: View;
  // Shown after a successful save — e.g. the OAuth "authorize on this machine" note.
  note?: string;
}

// Steps for a custom connector, or for editing an existing one. Transport is INFERRED
// from the answer rather than asked as a separate question: an https:// answer is an
// http server, anything else is a stdio command line. That matches mcpControl's own
// inference (`draft.url || prev.url ? "http" : "stdio"`), so there's one rule, not two.
function customSteps(existing?: RemoteMcpServer): Step[] {
  const target = existing
    ? existing.transport === "http"
      ? existing.url
      : [existing.command, existing.argsPreview].filter(Boolean).join(" ")
    : undefined;
  return [
    {
      key: "name",
      prompt: "Connector name",
      hint: "Lowercase, no spaces — it prefixes every tool, e.g. github__list_issues",
      initial: existing?.name,
    },
    {
      key: "target",
      prompt: "Launch command, or an https:// URL",
      hint: "e.g. npx -y @modelcontextprotocol/server-memory  ·  or  https://mcp.example.com/sse",
      initial: target,
    },
    {
      key: "env",
      prompt: "Environment variables (optional)",
      hint: "KEY=value, comma-separated. Leave blank for none.",
      optional: true,
    },
  ];
}

// Parse the "KEY=value, KEY2=value2" answer. Malformed fragments are skipped rather
// than rejected — a stray comma shouldn't cost the user the whole form.
function parseEnv(answer: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of answer.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key) env[key] = val;
  }
  return env;
}

function buildCustomDraft(answers: Record<string, string>): McpDraft {
  const name = (answers.name ?? "").trim();
  const target = (answers.target ?? "").trim();
  const draft: McpDraft = { name };
  if (/^https?:\/\//i.test(target)) {
    draft.transport = "http";
    draft.url = target;
    draft.oauth = true;
  } else {
    draft.transport = "stdio";
    const parts = target.split(/\s+/).filter(Boolean);
    draft.command = parts[0] ?? "";
    draft.args = parts.slice(1);
  }
  const env = parseEnv(answers.env ?? "");
  if (Object.keys(env).length > 0) draft.env = env;
  return draft;
}

// Expand a catalog entry into its wizard. needs:"none"/"oauth" produce zero steps —
// the panel saves immediately and shows the note.
function pendingFromCatalog(e: CatalogEntry): Pending {
  const steps: Step[] = [];
  if (e.needs === "token") {
    for (const key of promptOrder(e)) {
      steps.push({
        key: `env:${key}`,
        prompt: `Paste your ${key}`,
        hint: e.credUrl ? `Get one at ${e.credUrl}` : undefined,
        secret: true,
        // Only the primary credential is required; the rest can be filled later.
        optional: key !== e.fill,
      });
    }
  } else if (e.needs === "path" && e.fill) {
    steps.push({
      key: "fill",
      prompt: e.fill.startsWith("postgres") ? "Connection string" : "Folder path",
      hint: `Replaces the placeholder ${e.fill}`,
      initial: e.fill,
    });
  }
  return {
    title: e.label,
    steps,
    origin: "catalog",
    build: (answers) => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(answers)) {
        if (k.startsWith("env:")) env[k.slice(4)] = v;
      }
      return draftFromCatalog(e, { env, fill: answers.fill });
    },
    note:
      e.needs === "oauth"
        ? `Authorize it in a browser on THIS machine: /mcp-auth ${e.name}`
        : undefined,
  };
}

// One row in the catalog picker. "Custom…" is a real row rather than a separate key
// so there is exactly one way to start an add.
interface CatalogRow {
  entry?: CatalogEntry; // undefined → the "Custom…" row
  label: string;
  blurb: string;
  needsLabel: string;
}

const NEEDS_LABEL: Record<string, string> = {
  token: "needs a token",
  path: "needs a path",
  oauth: "browser sign-in",
  none: "no setup",
};

function catalogRows(): CatalogRow[] {
  const rows: CatalogRow[] = MCP_CATALOG.map((e) => ({
    entry: e,
    label: e.label,
    blurb: e.blurb,
    needsLabel: NEEDS_LABEL[e.needs] ?? "",
  }));
  rows.push({
    label: "Custom…",
    blurb: "Any stdio command or http URL.",
    needsLabel: "",
  });
  return rows;
}

// ---------------------------------------------------------------------------
// The panel.
// ---------------------------------------------------------------------------
class ConnectPanel extends Container {
  private tui: TuiLike;
  private theme: ThemeLike;
  private control = makeMcpControl();
  private close: (r: ConnectResult) => void;

  private view: View = "list";
  private servers: RemoteMcpServer[] = [];
  private changed = false;
  private status = "";

  // list view
  private index = 0;
  // Name of the connector a first `d` has armed for removal; see removeSelected.
  private armedRemoval?: string;

  // catalog view
  private rows: CatalogRow[] = [];
  private filtered: CatalogRow[] = [];
  private catalogIndex = 0;
  private search = new Input();

  // form view
  private pending?: Pending;
  private stepIndex = 0;
  private answers: Record<string, string> = {};
  private field = new Input();
  private secret = new SecretField();

  private body = new Container();
  private footer = new Text("", 1, 0);
  private _focused = false;

  constructor(opts: { tui: TuiLike; theme: ThemeLike; close: (r: ConnectResult) => void }) {
    super();
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.close = opts.close;

    this.addChild(this.body);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);

    this.search.onSubmit = () => this.chooseCatalogRow();
    this.field.onSubmit = () => this.submitStep();

    this.reload();
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.search.focused = v && this.view === "catalog";
    this.field.focused = v && this.view === "form" && !this.currentStep()?.secret;
  }

  private reload(): void {
    try {
      // Sorted by name, not by however the config file happened to be written. The
      // list is a place you come back to — a row that moves because someone added a
      // connector from the phone is a row you'll toggle or delete by mistake.
      this.servers = this.control.list().sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      this.servers = [];
      this.status = `Couldn't read MCP config: ${(e as Error).message}`;
    }
    if (this.index >= this.servers.length) this.index = Math.max(0, this.servers.length - 1);
    this.refresh();
  }

  private currentStep(): Step | undefined {
    return this.pending?.steps[this.stepIndex];
  }

  // -- rendering ------------------------------------------------------------

  private refresh(): void {
    const t = this.theme;
    this.body.clear();
    if (this.view === "list") this.renderList();
    else if (this.view === "catalog") this.renderCatalog();
    else this.renderForm();
    if (this.status) {
      this.body.addChild(new Spacer(1));
      this.body.addChild(new Text(t.fg("muted", `  ${this.status}`), 1, 0));
    }
    this.tui.requestRender();
  }

  // The one-line summary of a connector's readiness. This is the whole reason the
  // list exists: "saved" and "usable" are different states, and an http/OAuth server
  // that was never authorized fails only at call time otherwise.
  private statusOf(s: RemoteMcpServer): string {
    const t = this.theme;
    if (s.transport === "http" && s.oauth) {
      return t.fg("warning", `⚠ authorize: /mcp-auth ${s.name}`);
    }
    if (s.envKeys.length > 0) {
      const missing = s.envKeys.filter((k) => !s.secretsSet.includes(k));
      if (missing.length > 0) return t.fg("warning", `⚠ needs ${missing.join(", ")}`);
      return t.fg("success", "⚿ credentials set");
    }
    return t.fg("muted", s.argsPreview ?? s.url ?? "");
  }

  private renderList(): void {
    const t = this.theme;
    this.body.addChild(new Text(t.fg("accent", t.bold("Connect a service")), 1, 0));
    this.body.addChild(
      new Text(t.fg("muted", "MCP connectors on this machine — shared with the app and the harbor."), 1, 0),
    );
    this.body.addChild(new Spacer(1));

    if (this.servers.length === 0) {
      this.body.addChild(new Text(t.fg("muted", "  No connectors yet."), 1, 0));
    } else {
      const width = Math.max(...this.servers.map((s) => s.name.length));
      this.servers.forEach((s, i) => {
        const sel = i === this.index;
        const prefix = sel ? t.fg("accent", "→ ") : "  ";
        const dot = s.enabled ? t.fg("success", "●") : t.fg("muted", "○");
        const name = sel ? t.fg("accent", s.name.padEnd(width)) : t.fg("text", s.name.padEnd(width));
        const transport = t.fg("muted", s.transport.padEnd(5));
        this.body.addChild(new Text(`${prefix}${dot} ${name}  ${transport}  ${this.statusOf(s)}`, 1, 0));
      });
    }

    this.body.addChild(new Spacer(1));
    const addSel = this.index === this.servers.length;
    this.body.addChild(
      new Text(
        addSel ? t.fg("accent", "→ + Add a connector…") : t.fg("muted", "  + Add a connector…"),
        1,
        0,
      ),
    );
    this.footer.setText(
      t.fg("muted", "↑↓ move   space enable/disable   ⏎ edit   a add   d remove   esc done"),
    );
  }

  private renderCatalog(): void {
    const t = this.theme;
    this.body.addChild(new Text(t.fg("accent", t.bold("Add a connector")), 1, 0));
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.search);
    this.body.addChild(new Spacer(1));

    if (this.filtered.length === 0) {
      this.body.addChild(new Text(t.fg("muted", "  No matches"), 1, 0));
    } else {
      const width = Math.max(...this.filtered.map((r) => r.label.length));
      const start = Math.max(
        0,
        Math.min(this.catalogIndex - Math.floor(MAX_VISIBLE / 2), this.filtered.length - MAX_VISIBLE),
      );
      const end = Math.min(start + MAX_VISIBLE, this.filtered.length);
      for (let i = start; i < end; i++) {
        const row = this.filtered[i];
        const sel = i === this.catalogIndex;
        const prefix = sel ? t.fg("accent", "→ ") : "  ";
        const label = sel ? t.fg("accent", row.label.padEnd(width)) : t.fg("text", row.label.padEnd(width));
        const needs = row.needsLabel ? t.fg("muted", `  ${row.needsLabel}`) : "";
        this.body.addChild(new Text(`${prefix}${label}  ${t.fg("muted", row.blurb)}${needs}`, 1, 0));
      }
    }
    this.footer.setText(t.fg("muted", "↑↓ move   ⏎ choose   type to search   esc back"));
  }

  private renderForm(): void {
    const t = this.theme;
    const p = this.pending!;
    const step = this.currentStep()!;
    const counter = p.steps.length > 1 ? `  ${this.stepIndex + 1}/${p.steps.length}` : "";
    this.body.addChild(new Text(t.fg("accent", t.bold(p.title)) + t.fg("muted", counter), 1, 0));
    this.body.addChild(new Spacer(1));
    this.body.addChild(new Text(`  ${t.fg("text", step.prompt)}`, 1, 0));
    if (step.hint) this.body.addChild(new Text(`  ${t.fg("muted", step.hint)}`, 1, 0));
    this.body.addChild(new Spacer(1));

    if (step.secret) {
      const shown = this.secret.display();
      this.body.addChild(
        new Text(`  ${shown || t.fg("muted", "(nothing typed yet)")}`, 1, 0),
      );
    } else {
      this.body.addChild(this.field);
    }

    this.footer.setText(
      t.fg(
        "muted",
        step.optional
          ? "⏎ next (blank to skip)   esc back"
          : "⏎ next   esc back",
      ),
    );
  }

  // -- actions --------------------------------------------------------------

  private openCatalog(): void {
    this.view = "catalog";
    this.rows = catalogRows();
    // Servers already configured are still listed — re-picking one is a legitimate
    // way to re-enter a rotated token, and save() merges rather than clobbers.
    this.filtered = this.rows;
    this.catalogIndex = 0;
    this.search.setValue("");
    this.search.focused = this._focused;
    this.field.focused = false;
    this.status = "";
    this.refresh();
  }

  private applySearch(): void {
    const q = this.search.getValue();
    this.filtered = q
      ? fuzzyFilter(this.rows, q, (r: CatalogRow) => `${r.label} ${r.blurb}`)
      : this.rows;
    this.catalogIndex = 0;
    this.refresh();
  }

  private chooseCatalogRow(): void {
    const row = this.filtered[this.catalogIndex];
    if (!row) return;
    const pending = row.entry
      ? pendingFromCatalog(row.entry)
      : {
          title: "Custom connector",
          steps: customSteps(),
          origin: "catalog" as View,
          build: buildCustomDraft,
        };
    this.startForm(pending);
  }

  private startForm(pending: Pending): void {
    this.pending = pending;
    this.stepIndex = 0;
    this.answers = {};
    // Zero-step entries (Memory, Playwright, Linear) save on the spot — there is
    // nothing to ask, and making the user press enter through an empty form would
    // be ceremony rather than confirmation.
    if (pending.steps.length === 0) {
      this.save();
      return;
    }
    this.view = "form";
    this.loadStep();
  }

  private loadStep(): void {
    const step = this.currentStep()!;
    this.secret.value = "";
    this.field.setValue(step.initial ?? "");
    this.field.focused = this._focused && !step.secret;
    this.search.focused = false;
    this.refresh();
  }

  private submitStep(): void {
    const step = this.currentStep()!;
    const value = step.secret ? this.secret.value : this.field.getValue().trim();
    if (!value && !step.optional) {
      this.status = "That one's required.";
      this.refresh();
      return;
    }
    this.answers[step.key] = value;
    this.status = "";
    if (this.stepIndex < this.pending!.steps.length - 1) {
      this.stepIndex++;
      this.loadStep();
      return;
    }
    this.save();
  }

  private save(): void {
    const p = this.pending!;
    let res: { ok: boolean; message?: string };
    try {
      res = this.control.save(p.build(this.answers));
    } catch (e) {
      res = { ok: false, message: (e as Error).message };
    }
    if (!res.ok) {
      // Stay in the form so the answers aren't lost to a fixable validation error.
      this.status = res.message ?? "Couldn't save that connector.";
      if (this.view === "form") this.refresh();
      else {
        this.view = "list";
        this.reload();
      }
      return;
    }
    this.changed = true;
    this.status = p.note ? `${res.message} ${p.note}` : (res.message ?? "Saved.");
    this.pending = undefined;
    this.view = "list";
    this.reload();
  }

  private toggleSelected(): void {
    const s = this.servers[this.index];
    if (!s) return;
    const res = this.control.setEnabled(s.name, !s.enabled);
    if (res.ok) this.changed = true;
    this.status = res.message ?? "";
    this.reload();
  }

  // Removal is the one irreversible action here — a deleted connector takes its
  // credential with it, and there is no undo. So `d` ARMS and a second `d` confirms,
  // rather than a single keystroke next to the navigation keys wiping a token you'd
  // have to go re-mint. Any other key (including moving the cursor) disarms.
  private removeSelected(): void {
    const s = this.servers[this.index];
    if (!s) return;
    if (this.armedRemoval !== s.name) {
      this.armedRemoval = s.name;
      this.status = `Press d again to remove "${s.name}"${
        s.secretsSet.length > 0 ? " and its stored credentials" : ""
      }.`;
      this.refresh();
      return;
    }
    this.armedRemoval = undefined;
    const res = this.control.remove(s.name);
    if (res.ok) this.changed = true;
    this.status = res.message ?? "";
    this.reload();
  }

  private editSelected(): void {
    const s = this.servers[this.index];
    if (!s) return;
    this.startForm({
      title: `Edit ${s.name}`,
      steps: customSteps(s),
      origin: "list",
      build: buildCustomDraft,
    });
  }

  // -- input ----------------------------------------------------------------

  handleInput(data: string): void {
    if (this.view === "list") return this.handleListInput(data);
    if (this.view === "catalog") return this.handleCatalogInput(data);
    return this.handleFormInput(data);
  }

  private handleListInput(data: string): void {
    const kb = getKeybindings();
    // The "+ Add a connector…" row sits one past the end of the server list.
    const last = this.servers.length;
    // Anything that isn't a second `d` cancels an armed removal — moving the cursor
    // must never leave a primed delete pointing at a different row.
    if (data !== "d" && data !== "x" && this.armedRemoval) {
      this.armedRemoval = undefined;
      this.status = "";
    }
    if (kb.matches(data, "tui.select.up")) {
      this.index = this.index === 0 ? last : this.index - 1;
      this.refresh();
    } else if (kb.matches(data, "tui.select.down")) {
      this.index = this.index === last ? 0 : this.index + 1;
      this.refresh();
    } else if (kb.matches(data, "tui.select.confirm")) {
      if (this.index === last) this.openCatalog();
      else this.editSelected();
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.close({
        changed: this.changed,
        message: this.changed ? this.status || "MCP connectors updated." : undefined,
      });
    } else if (data === " ") {
      if (this.index !== last) this.toggleSelected();
    } else if (data === "a" || data === "A") {
      this.openCatalog();
    } else if (data === "d" || data === "x") {
      if (this.index !== last) this.removeSelected();
    }
  }

  private handleCatalogInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      if (!this.filtered.length) return;
      this.catalogIndex = this.catalogIndex === 0 ? this.filtered.length - 1 : this.catalogIndex - 1;
      this.refresh();
    } else if (kb.matches(data, "tui.select.down")) {
      if (!this.filtered.length) return;
      this.catalogIndex = this.catalogIndex === this.filtered.length - 1 ? 0 : this.catalogIndex + 1;
      this.refresh();
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.chooseCatalogRow();
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.view = "list";
      this.search.focused = false;
      this.status = "";
      this.refresh();
    } else {
      this.search.handleInput(data);
      this.applySearch();
    }
  }

  private handleFormInput(data: string): void {
    const kb = getKeybindings();
    const step = this.currentStep()!;
    if (kb.matches(data, "tui.select.cancel")) {
      // Back a step, or out of the form entirely from the first one.
      if (this.stepIndex > 0) {
        this.stepIndex--;
        this.loadStep();
      } else {
        this.view = this.pending?.origin ?? "list";
        this.pending = undefined;
        this.status = "";
        this.field.focused = false;
        this.search.focused = this._focused && this.view === "catalog";
        this.refresh();
      }
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      this.submitStep();
      return;
    }
    if (step.secret) {
      this.secret.handleInput(data);
      this.refresh();
      return;
    }
    this.field.handleInput(data);
    this.refresh();
  }
}

// ---------------------------------------------------------------------------
// Extension entrypoint.
// ---------------------------------------------------------------------------
export default function privateerConnect(pi: {
  registerCommand?: (name: string, opts: unknown) => void;
}): void {
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("connect", {
    description: "Add, enable, or remove MCP connectors (GitHub, Notion, Linear, …)",
    handler: async (_args: string, ctx: any): Promise<void> => {
      const ui = ctx?.ui;
      if (!ui?.custom) {
        ui?.notify?.("/connect needs an interactive terminal.", "warning");
        return;
      }

      const result: ConnectResult | undefined = await ui.custom(
        (tui: TuiLike, theme: ThemeLike, _kb: unknown, close: (r?: ConnectResult) => void) =>
          new ConnectPanel({ tui, theme, close: (r) => close(r) }),
      );

      if (!result?.changed) return;
      // Reload so pi-mcp-adapter re-reads mcp.json in this session — the same thing
      // its own `/mcp setup` does after a write. Without it the new connector only
      // appears on the next launch, which reads as "it didn't work".
      try {
        await ctx.reload?.();
      } catch {
        /* non-fatal — the config is written either way */
      }
      ui.notify?.(`${result.message ?? "MCP connectors updated."}  Check it with /mcp.`, "info");
    },
  });
}
