// APPROVALS FOR A RUN WITH NO SCREEN, answered from the Privateer app.
//
//   privateer -p --approve-in-app "make the trailer"
//
// A `-p` run's gate has nobody to ask, so it denies. With --approve-in-app it instead
// brings up the same E2EE relay `/remote-access` uses, waits for the app to attach to
// this terminal, and puts the question there — "Generate a video (billed…) · about
// $0.50" — and denies only if nobody answers before the timeout. The relay is started
// LAZILY, on the first ask: a run that never needs an approval never opens a socket.
//
// WHAT THIS IS NOT. The relay reaches an app that is running (foreground, or
// backgrounded with its socket alive — the app raises its own local notification for an
// approval then). An app that is fully closed is only reachable by a server-sent push,
// which does not exist yet (docs/push-on-gate-server.md). So the waiting line says to
// OPEN the app, rather than promising a notification that may never arrive.
//
// POSTURE. Nothing here widens what the gate allows: this is only the asker the gate
// calls when it has already decided to ask. Fail-closed throughout — not signed in, no
// relay, timeout, abort: deny. "Allow and remember" from the app counts as allow-once,
// because a headless run has no later turn for a remembered rule to help and the gate
// never remembers the always-ask kinds anyway. A PROMPT sent from the app is refused:
// this terminal takes approvals, not instructions, for the length of the run.

import { RemoteBridge, type RelayLike } from "./remoteBridge.ts";
import type { PermissionRequest } from "../permissions/gate.ts";
import type { AskOutcome } from "../permissions/modeGate.ts";
import type { RelayCallbacks } from "./relayClient.ts";

/** The relay surface this needs beyond the bridge's: lifecycle and presence. */
export interface HeadlessRelay extends RelayLike {
  start(): Promise<void>;
  stop(): void;
  hasController(): boolean;
}

export interface HeadlessApprovalOptions {
  /** Per ask: how long to wait for the app to attach AND answer. */
  timeoutMs: number;
  /** Where the waiting / outcome lines go (stderr — stdout may be the answer or JSON). */
  log: (line: string) => void;
  signedIn: () => boolean;
  makeRelay: (callbacks: RelayCallbacks) => HeadlessRelay;
  /** Label for this terminal in the app. */
  label?: string;
  /** Presence poll interval; tests shorten it. */
  pollMs?: number;
}

const mins = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);

export class HeadlessAppApprover {
  private bridge?: RemoteBridge;
  private relay?: HeadlessRelay;
  private starting?: Promise<void>;
  private closed = false;
  // How many times the app has left. A deny that coincides with a departure is the
  // bridge failing the ask closed, not a person pressing Deny — and presence alone
  // can't tell, because the app may already be back by the time we look.
  private departures = 0;

  constructor(private readonly opts: HeadlessApprovalOptions) {}

  private ensureRelay(): Promise<void> {
    if (this.starting) return this.starting;
    const bridge = new RemoteBridge({
      onPrompt: () => bridge.sendNotice("This terminal is a headless run waiting for approvals only — it can't take a prompt."),
      onCommand: () => bridge.sendNotice("This terminal is a headless run waiting for approvals only — it can't run commands."),
      onControllerDetached: () => this.departures++,
    });
    this.bridge = bridge;
    this.relay = this.opts.makeRelay(bridge.callbacks);
    bridge.attachRelay(this.relay);
    this.starting = this.relay.start();
    return this.starting;
  }

  private async waitForController(deadline: number, signal?: AbortSignal): Promise<boolean> {
    const poll = this.opts.pollMs ?? 500;
    while (!this.closed && !signal?.aborted && Date.now() < deadline) {
      if (this.relay?.hasController()) return true;
      await new Promise((r) => setTimeout(r, Math.min(poll, Math.max(0, deadline - Date.now()))));
    }
    return !!this.relay?.hasController() && !signal?.aborted;
  }

  /** The gate's asker for this run. `priceNote` (e.g. "about $0.50") rides on the prompt. */
  async ask(req: PermissionRequest, signal?: AbortSignal, priceNote?: string): Promise<AskOutcome> {
    const what = `${req.title}${priceNote ? ` · ${priceNote}` : ""}`;
    if (!this.opts.signedIn()) {
      this.opts.log(`⚓ ${what} — denied: --approve-in-app needs this machine signed in to Privateer (run \`privateer\`, then /login).`);
      return "deny";
    }
    const deadline = Date.now() + this.opts.timeoutMs;
    try {
      await this.ensureRelay();
    } catch (e) {
      this.opts.log(`⚓ ${what} — denied: couldn't reach the Privateer relay (${e instanceof Error ? e.message : String(e)}).`);
      return "deny";
    }
    const asked: PermissionRequest = priceNote ? { ...req, detail: `${req.detail} · ${priceNote}` } : req;

    this.opts.log(
      `⚓ Approval needed: ${what}\n` +
        `   Waiting up to ${mins(this.opts.timeoutMs)} — open the Privateer app and approve it there` +
        (this.opts.label ? ` (terminal "${this.opts.label}")` : "") +
        ".",
    );

    // Loop, because the app coming and going is normal (a phone locks, a user switches
    // apps): a detach fails the pending ask closed, and the next attach gets it again.
    while (Date.now() < deadline && !signal?.aborted && !this.closed) {
      if (!(await this.waitForController(deadline, signal))) break;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
      let outcome: AskOutcome;
      const departuresBefore = this.departures;
      try {
        outcome = await this.bridge!.remoteAsk(asked, controller.signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      if (outcome !== "deny") {
        this.opts.log(`⚓ Approved in the app: ${what}`);
        return "allow";
      }
      // A real "Deny" is the answer. A deny because the app left is not — wait for it
      // to come back and ask again.
      // A dropped socket fails it closed the same way, with no detach to count.
      if (controller.signal.aborted || (this.departures === departuresBefore && this.relay?.isConnected())) break;
    }
    const why = signal?.aborted ? "the run was cancelled" : `no answer from the app in ${mins(this.opts.timeoutMs)}`;
    const deniedInApp = !signal?.aborted && Date.now() < deadline;
    this.opts.log(`⚓ Denied: ${what} — ${deniedInApp ? "denied in the app" : why}.`);
    return "deny";
  }

  /** Drop the relay. Safe to call twice, and before anything started. */
  close(): void {
    this.closed = true;
    this.relay?.stop();
    this.bridge?.dispose();
  }
}
