// A stall watchdog for headless runs.
//
// `privateer -p` waits on the model with no limit. A provider that accepts the request
// and then sends nothing (measured on the account channel: glm-5-2 stalled 5 of 14
// requests, see providers/defaultModel.ts) leaves the run hanging forever with nothing
// on stdout. That is what a 14-minute "hang" on 2026-10-02 looked like from the outside;
// the session file never appeared, because Pi writes it only once a first reply lands.
//
// So: armed when a request goes out, re-armed by every streamed event (text, thinking,
// tool-call deltas all count, so a slow but live stream never trips it), disarmed when
// the message ends. Between requests (tool execution) it is off — a long local command
// is not a provider stall. If it fires, the caller aborts the turn and says why.
//
// The limit: PRIVATEER_REPLY_TIMEOUT seconds, default 180, 0 turns it off. Silence, not
// total time, is what is measured, so a long answer is never cut off for being long.

export const REPLY_TIMEOUT_ENV = "PRIVATEER_REPLY_TIMEOUT";
export const DEFAULT_REPLY_TIMEOUT_MS = 180_000;

/** The stall limit in ms from the environment; 0 means off. Garbage falls back to the default. */
export function replyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[REPLY_TIMEOUT_ENV] ?? "").trim();
  if (!raw) return DEFAULT_REPLY_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REPLY_TIMEOUT_MS;
  return Math.round(n * 1000);
}

export class StallWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fired = false;

  constructor(
    private readonly ms: number,
    private readonly onStall: () => void,
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
  ) {}

  /** A request went out, or something streamed: (re)start the silence clock. */
  arm(): void {
    if (this.ms <= 0 || this.fired) return;
    this.disarm();
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.fired = true;
      this.onStall();
    }, this.ms);
    // Never the reason a finished run stays alive (see docs/one-shot-exit.md).
    (this.timer as { unref?: () => void })?.unref?.();
  }

  /** The message ended, or the run did: nothing to wait on. */
  disarm(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  get stalled(): boolean {
    return this.fired;
  }
}
