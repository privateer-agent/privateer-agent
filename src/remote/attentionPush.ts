// "Your agent is asking you something" — a push to the account's phones when a
// question (ask_user_question, a select, a text prompt) is put to an app that isn't
// there to see it.
//
// A question sent up the relay only reaches a LIVE socket. A phone that backgrounded
// a minute ago has none, so the question sat held on this machine (remoteBridge's
// holdOpenQuestions) with nothing telling anyone it was waiting — the user found it
// by chance, or after the hold ran out and the tool came back as an error.
//
// Content-free on purpose, like the Inbox nudge (server services/pushService.js): the
// question itself never leaves the relay, so the push says only that one is waiting.
// Fire-and-forget and throttled — a failed or skipped push must never touch the turn.

const COOLDOWN_MS = 30_000;
let lastAt = 0;
let sink: (() => void) | null = null;

export function requestAttentionPush(): void {
  const now = Date.now();
  if (now - lastAt < COOLDOWN_MS) return;
  lastAt = now;
  if (sink) return sink();
  void (async () => {
    try {
      const { apiRequest, hasCredentials } = await import("../auth/privateer.ts");
      if (!hasCredentials()) return;
      await apiRequest("/api/push/attention", { method: "POST", signal: AbortSignal.timeout(10_000) });
    } catch {
      /* best effort — the question is still held and re-sent when the app comes back */
    }
  })();
}

/** Test seam: count pushes instead of sending them (null restores the real one), and
 *  forget the cooldown. Tests run on machines that are signed in — without this a
 *  bridge test would buzz the developer's phone. */
export function setAttentionPushSink(fn: (() => void) | null): void {
  sink = fn;
  lastAt = 0;
}
