// Require-ZDR misses on the account channel, and the SESSION-scoped way past one.
//
// THE FAILURE. An account with Require ZDR on (the default) has every account-channel
// request pinned to zero-retention endpoints server-side. A model with no ZDR endpoint
// then fails. Servers before 2026-11-26 forwarded OpenRouter's raw 404 ("No endpoints
// found matching your data policy (Zero data retention). Configure:
// https://openrouter.ai/settings/privacy"), which is OUR OpenRouter account's settings
// page and useless to the user. Newer servers answer with the typed code
// ZDR_NO_ENDPOINT plus a few ZDR models the account can use. Both shapes are read here.
//
// WHAT THE USER CAN DO. Three things, offered as one question when someone is at the
// terminal: switch to a suggested ZDR model, use THIS model without ZDR for the rest of
// this session, or cancel. `/zdr` does the same opt-out for every model.
//
// WHY SESSION-ONLY, NEVER THE ACCOUNT SETTING. Require ZDR covers the app, every harbor
// and every device on the account. Turning it off is a decision for Settings → Privacy,
// where it is made with the whole account in view, not a keystroke in one terminal that
// may be driven from a phone. So the opt-out here is a per-request field
// (`requireZdr: false`, which the server's resolveRequireZdr honours) that lives in this
// process's memory only. Nothing is written to disk or to the account, and a new
// session starts back under the account's setting.
//
// UNATTENDED RUNS (harbor, `-p`, channels, ACP without a UI) never opt out. They get the
// readable error and stop.
//
// State lives on globalThis because jiti gives each extension its own instance of this
// file (see the note in auth/privateer.ts); the provider hook and the /zdr command must
// see one state.

export const ZDR_NO_ENDPOINT = "ZDR_NO_ENDPOINT";

interface ZdrState {
  allModels: boolean; // `/zdr off` — every ZDR-channel model, this session
  models: Set<string>; // per-model opt-outs chosen from the miss prompt
  declined: Set<string>; // models the user said Cancel for: don't ask again this session
  pending: ZdrMiss | null; // the miss to ask about once the turn settles
}

const KEY = Symbol.for("privateer.zdrSession");
function state(): ZdrState {
  const g = globalThis as unknown as { [KEY]?: ZdrState };
  return (g[KEY] ??= { allModels: false, models: new Set(), declined: new Set(), pending: null });
}

/** Test-only: forget everything. */
export function resetZdrSession(): void {
  const s = state();
  s.allModels = false;
  s.models.clear();
  s.declined.clear();
  s.pending = null;
}

export interface ZdrMiss {
  model?: string;
  alternatives: string[];
}

// Server-supplied ids are displayed and then looked up in the registry; anything that
// doesn't look like a model id is dropped rather than rendered.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,127}$/;

/** Recognise a Require-ZDR miss in an error message, typed or legacy. Pure. */
export function parseZdrMiss(text: string | null | undefined): ZdrMiss | null {
  if (typeof text !== "string" || !text) return null;
  const typed = text.includes(ZDR_NO_ENDPOINT);
  const legacy =
    /data policy/i.test(text) && /(zero data retention|Filter by Data Policy)/i.test(text);
  if (!typed && !legacy) return null;

  let model: string | undefined;
  let alternatives: string[] = [];
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start)) as Record<string, unknown>;
      const err = (parsed.error && typeof parsed.error === "object" ? parsed.error : parsed) as Record<string, unknown>;
      if (typeof err.model === "string" && MODEL_ID.test(err.model)) model = err.model;
      if (Array.isArray(err.alternatives)) {
        alternatives = err.alternatives
          .filter((a): a is string => typeof a === "string" && MODEL_ID.test(a))
          .slice(0, 5);
      }
    } catch {
      /* not JSON past the status — the legacy prose, or a truncated body */
    }
  }
  return { model, alternatives };
}

/**
 * The message that replaces the raw error. Keeps the leading "404" so the engine still
 * classifies it as a hard client failure (no retry, no compaction). Pure.
 */
export function describeZdrMiss(miss: ZdrMiss, fallbackModel: string | undefined, interactive: boolean): string {
  const model = miss.model ?? fallbackModel ?? "This model";
  const lines = [`404 ${model} has no Zero Data Retention endpoint, and your account requires ZDR.`];
  if (miss.alternatives.length) lines.push(`ZDR models you can use: ${miss.alternatives.join(", ")}`);
  lines.push(
    interactive
      ? "Pick a ZDR model with /models, or run /zdr off to allow non-ZDR models for this session."
      : "Pick a ZDR model, or allow non-ZDR models in Privateer Settings → Privacy.",
  );
  return lines.join("\n");
}

/** Whether requests for `modelId` go out with the session opt-out. */
export function zdrOptedOut(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const s = state();
  return s.allModels || s.models.has(modelId);
}

export function zdrSessionSummary(): string | null {
  const s = state();
  if (s.allModels) return "all models";
  if (s.models.size) return [...s.models].join(", ");
  return null;
}

/**
 * The provider-request rewrite. `isZdrChannel` says whether the model routes through the
 * server's ZDR channel at all. TEE models never touch OpenRouter, so there is nothing to
 * opt out of, and the field is left off rather than sent as noise.
 */
export function withZdrOptOut(payload: unknown, isZdrChannel: (id: string) => boolean): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  const model = (payload as { model?: unknown }).model;
  if (typeof model !== "string" || !isZdrChannel(model) || !zdrOptedOut(model)) return undefined;
  return { ...(payload as object), requireZdr: false };
}

export function setPendingZdrMiss(miss: ZdrMiss | null): void {
  state().pending = miss;
}

export function takePendingZdrMiss(): ZdrMiss | null {
  const s = state();
  const p = s.pending;
  s.pending = null;
  return p;
}

// ── The interactive half ──────────────────────────────────────────────────────

interface ZdrUi {
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  setStatus?: (key: string, text: string | undefined) => void;
}

export interface ZdrDeps {
  /** Resolve an account-channel model to something setModel accepts, or undefined. */
  findModel: (id: string) => unknown;
  setModel: (model: unknown) => Promise<boolean> | boolean;
  /** Persist the pick like /models does, so the next launch doesn't fail the same way. */
  saveDefault?: (ref: string) => void;
  /** Repaint anything that shows privacy posture. */
  onChange?: () => void;
}

const STATUS_KEY = "zdr";

export function paintZdrStatus(ui: ZdrUi | undefined): void {
  const summary = zdrSessionSummary();
  ui?.setStatus?.(STATUS_KEY, summary ? `⚠ non-ZDR this session (${summary})` : undefined);
}

export type ZdrPromptOutcome = "switched" | "opted-out" | "cancelled" | "skipped";

/**
 * Ask what to do about a miss. Only call with a real UI: unattended runs keep the
 * readable error and stop.
 */
export async function promptZdrMiss(
  miss: ZdrMiss,
  failedModel: string | undefined,
  ui: ZdrUi,
  deps: ZdrDeps,
): Promise<ZdrPromptOutcome> {
  const model = miss.model ?? failedModel;
  if (!ui.select || !model) return "skipped";
  const s = state();
  if (s.declined.has(model) || zdrOptedOut(model)) return "skipped";

  // Only offer alternatives this terminal can actually switch to.
  const switchable = miss.alternatives
    .filter((id) => id !== model)
    .map((id) => ({ id, model: deps.findModel(id) }))
    .filter((a) => a.model !== undefined)
    .slice(0, 3);

  const switchRows = switchable.map((a, i) => `Switch to ${a.id}${i === 0 ? "  (recommended)" : ""}`);
  const optOutRow = `Use ${model} without ZDR for this session only`;
  const cancelRow = "Cancel";
  const picked = await ui.select(
    `${model} has no Zero Data Retention endpoint, and your account requires ZDR.`,
    [...switchRows, optOutRow, cancelRow],
  );

  if (picked === undefined || picked === cancelRow) {
    s.declined.add(model);
    ui.notify?.("Kept your account's ZDR requirement. /models picks a ZDR model; /zdr off allows non-ZDR for this session.", "info");
    return "cancelled";
  }
  if (picked === optOutRow) {
    s.models.add(model);
    paintZdrStatus(ui);
    deps.onChange?.();
    ui.notify?.(
      `${model} will run without ZDR until this session ends — its provider may retain your prompts. ` +
        `/zdr on puts the requirement back. Send your message again to retry.`,
      "warning",
    );
    return "opted-out";
  }
  const chosen = switchable[switchRows.indexOf(picked)];
  if (!chosen) return "cancelled";
  const ok = await deps.setModel(chosen.model);
  if (ok === false) {
    ui.notify?.(`Couldn't switch to ${chosen.id}.`, "error");
    return "cancelled";
  }
  deps.saveDefault?.(`privateer/${chosen.id}`);
  ui.notify?.(`Switched to ${chosen.id}. Send your message again to retry.`, "info");
  return "switched";
}

const OFF = new Set(["off", "allow", "disable", "no"]);
const ON = new Set(["on", "require", "enable", "yes", "reset"]);

/**
 * `/zdr`            show the session state
 * `/zdr off`        allow non-ZDR models for this session (asks first)
 * `/zdr on`         drop every session opt-out
 */
export async function runZdrCommand(args: string, ui: ZdrUi | undefined, deps: Pick<ZdrDeps, "onChange">): Promise<void> {
  const say = (m: string, level: "info" | "warning" | "error" = "info") => ui?.notify?.(m, level);
  const arg = String(args ?? "").trim().toLowerCase();
  const s = state();

  if (ON.has(arg)) {
    const had = zdrSessionSummary();
    s.allModels = false;
    s.models.clear();
    s.declined.clear();
    paintZdrStatus(ui);
    deps.onChange?.();
    say(had ? "ZDR requirement restored for this session." : "No session opt-out was set — your account's ZDR setting applies.");
    return;
  }

  if (OFF.has(arg)) {
    if (s.allModels) {
      say("Non-ZDR models are already allowed for this session. /zdr on to undo.");
      return;
    }
    // A confirmation, not a flag: this is the one direction that lowers privacy.
    if (!ui?.confirm) {
      say("/zdr off needs an interactive terminal to confirm.", "warning");
      return;
    }
    const yes = await ui.confirm(
      "Allow non-ZDR models for this session?",
      "Models without a Zero Data Retention endpoint will be used for the rest of this session. " +
        "Their providers may retain your prompts. Your account setting is not changed, and a new session " +
        "starts with ZDR required again.",
    );
    if (!yes) {
      say("Unchanged — ZDR still required.");
      return;
    }
    s.allModels = true;
    paintZdrStatus(ui);
    deps.onChange?.();
    say("Non-ZDR models allowed until this session ends. /zdr on to undo.", "warning");
    return;
  }

  if (arg && arg !== "status") {
    say("Usage: /zdr [on | off]", "warning");
    return;
  }
  const summary = zdrSessionSummary();
  say(
    summary
      ? `Session opt-out: non-ZDR allowed for ${summary}. /zdr on restores the requirement.`
      : "No session opt-out — your account's ZDR setting applies (Privateer Settings → Privacy). /zdr off allows non-ZDR for this session.",
  );
}
