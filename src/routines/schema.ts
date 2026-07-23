import { randomBytes } from "node:crypto";
import { z } from "zod";

// Where a routine's result is delivered after it runs. `file`/`relay`/`notice` stay
// inside the user's trust boundary. `cloud` stores an END-TO-END-ENCRYPTED copy in
// the account's server outbox for the app to catch up on when it next opens (the
// server only ever sees ciphertext — it can't read results — but does learn that a
// result exists, plus its time and rough size). `email` and `webhook:<name>` cross
// the boundary in plaintext to a third-party service, so they are opt-in and labeled
// at approval time.
export const DELIVERY_CHANNELS = ["file", "relay", "notice", "cloud", "email"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

// A webhook entry references a named endpoint from config `webhooks` — the routine
// itself never carries a URL, so all egress targets stay in one reviewable place.
const WEBHOOK_ENTRY_RE = /^webhook:[a-zA-Z0-9._-]{1,64}$/;

export const DeliveryEntry = z.union([
  z.enum(DELIVERY_CHANNELS),
  z.string().regex(WEBHOOK_ENTRY_RE, "webhook entries look like 'webhook:<config-name>'"),
]);
export type DeliveryEntry = z.infer<typeof DeliveryEntry>;

// The webhook name of a delivery entry, or null for the builtin channels.
export function webhookName(entry: string): string | null {
  return entry.startsWith("webhook:") ? entry.slice("webhook:".length) : null;
}

// A saved, unattended agent task. Persisted in routines.json and executed by the
// harbor when its trigger comes due. A routine's trigger is EITHER recurring (a
// cron expression) or one-off (`at`, a specific datetime) — exactly one is set.
export const Routine = z
  .object({
    // Stable id ("r-" + mint time), used as the key for updates/removal.
    id: z.string(),
    // Human label, unique across routines; used by /routine and as the output dir.
    name: z.string(),
    // Recurring trigger: a standard 5-field cron expression, e.g. "0 8 * * *".
    cron: z.string().optional(),
    // One-off trigger: an ISO-8601 datetime, e.g. "2026-07-02T15:00:00". Fires once,
    // then the routine disables itself.
    at: z.string().optional(),
    // The instruction handed to the agent each time the routine fires.
    prompt: z.string(),
    // Working directory the run executes in (file tools are confined here).
    cwd: z.string(),
    // Optional "provider:model" override; falls back to config.defaultModel.
    model: z.string().optional(),
    // Where to deliver the result. Defaults to on-box file output.
    delivery: z.array(DeliveryEntry).default(["file"]),
    // Optional tool allow-subset. Unset → the safe read/web set (see harbor). Entries
    // may be builtin names ("read") or MCP selectors — "<server>__<tool>" exact or
    // "<server>__*" for a whole server (see routines/toolSelect.ts). Selected MCP
    // tools run unattended under the auto-approve gate, so grant the minimum needed.
    tools: z.array(z.string()).optional(),
    // Paused routines stay in the file but never fire.
    enabled: z.boolean().default(true),
    // Bookkeeping, updated by the harbor after each run.
    lastRun: z.string().optional(),
    lastStatus: z.enum(["ok", "error"]).optional(),
    lastError: z.string().optional(),
    nextRun: z.string().optional(),
  })
  // Exactly one trigger: recurring (cron) or one-off (at).
  .refine((r) => Boolean(r.cron) !== Boolean(r.at), {
    message: "set exactly one of `cron` (recurring) or `at` (one-off)",
    path: ["cron"],
  });
export type Routine = z.infer<typeof Routine>;

// True when the routine repeats (cron) rather than firing once (at).
export function isRecurring(r: Pick<Routine, "cron" | "at">): boolean {
  return Boolean(r.cron);
}

// The on-disk shape of routines.json.
export const RoutineFile = z.object({
  routines: z.array(Routine).default([]),
});
export type RoutineFile = z.infer<typeof RoutineFile>;

// A time-ordered routine id minted once at creation.
//
// The random suffix is load-bearing, not decoration. This was `r-${Date.now()}` alone,
// so two routines created in the SAME MILLISECOND got the same id — and upsertRoutine
// keys on id, so the second silently overwrote the first. Creating routines in quick
// succession (an import, a scripted setup, a fast tap-tap in the app) could therefore
// lose one with no error anywhere. The timestamp prefix still sorts by creation order;
// the suffix just makes collisions vanishingly unlikely.
export function newRoutineId(): string {
  return `r-${Date.now()}-${randomBytes(4).toString("hex")}`;
}
