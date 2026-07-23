import type { Routine } from "./schema.ts";
import { webhookName } from "./schema.ts";
import { writeRoutineOutput, addNotice } from "./store.ts";

// A relay pusher, injected by the harbor. Given the finished result it either
// forwards it to an attached controller immediately ("live") or persists it to the
// pending-relay queue to flush when the app next attaches ("queued"). Either way the
// result is durably accounted for, so delivery doesn't add a notice backstop for it.
export type RelayPusher = (routine: Routine, content: string) => "live" | "queued";

// A cloud-outbox pusher, injected by the harbor. Seals the result to the account's
// outbox public key and POSTs the ciphertext to the server (E2EE store-and-forward),
// or buffers it durably on failure. Returns "sent" when the server accepted it,
// "queued" when it was persisted for a later flush — either way the result is
// durably accounted for. `status` is carried so the sealed envelope can render
// ok/error without re-parsing the markdown body.
export type CloudPusher = (routine: Routine, content: string, status: "ok" | "error") => Promise<"sent" | "queued">;

// A named webhook endpoint from config `webhooks`.
export interface WebhookTarget {
  url: string;
  format?: "slack" | "discord" | "json";
}

export interface DeliveryContext {
  pushRelay?: RelayPusher;
  // Seals + posts the result to the account's cloud outbox, or buffers it. Absent
  // (e.g. not signed in) → the `cloud` channel falls back to a notice so the result
  // isn't silently lost.
  pushCloud?: CloudPusher;
  // Named endpoints for "webhook:<name>" delivery entries; results POST here.
  webhooks?: Record<string, WebhookTarget>;
  // Scrubs secrets from anything leaving the machine. Webhook bodies always pass
  // through this when provided (the harbor wires in redactText).
  redact?: (text: string) => string;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
}

export interface DeliveryReport {
  // Channels that actually delivered (email is handled inside the agent run, so it
  // never appears here — see the harbor). Failed webhooks show as
  // "webhook:<name>(failed)" and leave a notice so the result isn't silently lost.
  delivered: string[];
  // Absolute path to latest.md when file delivery ran.
  filePath?: string;
}

function previewOf(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 120) || "(no output)";
}

// Message-size caps per format (Discord rejects >2000 chars of content; Slack
// truncates around 40k; plain JSON consumers get a generous bound).
const FORMAT_CAPS = { slack: 39_000, discord: 1_900, json: 100_000 } as const;

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap - 12) + "\n…truncated";
}

// Wrap the result for the target service. All formats carry plain text — no
// service-specific rich blocks, so a generic receiver can consume `json` too.
export function webhookBody(
  target: WebhookTarget,
  routine: Pick<Routine, "name">,
  content: string,
  status: "ok" | "error",
): string {
  const format = target.format ?? "json";
  const text = truncate(content, FORMAT_CAPS[format]);
  switch (format) {
    case "slack":
      return JSON.stringify({ text: `*${routine.name}* (${status})\n${text}` });
    case "discord":
      return JSON.stringify({ content: `**${routine.name}** (${status})\n${text}` });
    case "json":
      return JSON.stringify({ routine: routine.name, status, at: new Date().toISOString(), content: text });
  }
}

async function postWebhook(
  target: WebhookTarget,
  routine: Routine,
  content: string,
  status: "ok" | "error",
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl(target.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: webhookBody(target, routine, content, status),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Deliver a routine's result to its configured channels. `file` and `notice` are
// deterministic and on-box. `relay` pushes to an attached controller in real time
// (best-effort — the socket may be up with no controller attached), so we ALSO keep
// a durable record when the routine has no other on-box channel, guaranteeing the
// result is never silently lost. `webhook:<name>` POSTs the (redacted) result to a
// named endpoint from config; a failed or unconfigured webhook leaves a notice.
// `email` is intentionally not handled here: it is fulfilled inside the agent turn
// (the harbor adds the Gmail tool + an instruction to the prompt) so plaintext
// egress stays an explicit, gated action.
export async function deliver(
  routine: Routine,
  content: string,
  status: "ok" | "error",
  ctx: DeliveryContext = {},
): Promise<DeliveryReport> {
  const delivered: string[] = [];
  const wants = new Set(routine.delivery);
  let filePath: string | undefined;
  let noticed = false;

  const leaveNotice = () => {
    if (noticed) return;
    addNotice({ routine: routine.name, at: new Date().toISOString(), status, preview: previewOf(content), path: filePath });
    noticed = true;
  };

  // On-box copy.
  if (wants.has("file")) {
    filePath = writeRoutineOutput(routine.name, content);
    delivered.push("file");
  }

  // Relay: pushed live to an attached controller, or queued to flush when the app
  // next attaches (the harbor persists that queue, so it's durable either way). Only
  // when no pusher is wired at all do we fall back to a notice so it isn't lost.
  if (wants.has("relay")) {
    const pushed = ctx.pushRelay?.(routine, content);
    if (pushed === "live") delivered.push("relay");
    else if (pushed === "queued") delivered.push("relay(queued)");
    else if (!wants.has("file") && !wants.has("notice")) {
      leaveNotice();
      delivered.push("notice(backstop)");
    }
  }

  // Cloud outbox: sealed E2EE store-and-forward. "sent" reached the server; "queued"
  // was buffered on disk (offline / server down / app hasn't published its outbox key
  // yet) and flushes later — both are durable. Only when no pusher is wired at all,
  // and nothing else keeps a durable record, do we fall back to a notice.
  if (wants.has("cloud")) {
    const sent = ctx.pushCloud ? await ctx.pushCloud(routine, content, status) : undefined;
    if (sent === "sent") delivered.push("cloud");
    else if (sent === "queued") delivered.push("cloud(queued)");
    else if (!wants.has("file") && !wants.has("notice") && !wants.has("relay")) {
      leaveNotice();
      delivered.push("notice(backstop)");
    }
  }

  // Webhooks: plaintext leaves the machine, so the body is always redacted when a
  // scrubber is wired. Any failure (unconfigured name, HTTP error, timeout) leaves
  // a notice so the user learns the result existed and the push didn't happen.
  for (const entry of routine.delivery) {
    const name = webhookName(entry);
    if (!name) continue;
    const target = ctx.webhooks?.[name];
    if (!target) {
      leaveNotice();
      delivered.push(`${entry}(unconfigured)`);
      continue;
    }
    try {
      const body = ctx.redact ? ctx.redact(content) : content;
      await postWebhook(target, routine, body, status, ctx.fetchImpl ?? fetch);
      delivered.push(entry);
    } catch {
      leaveNotice();
      delivered.push(`${entry}(failed)`);
    }
  }

  if (wants.has("notice")) {
    leaveNotice();
    delivered.push("notice");
  }

  return { delivered, filePath };
}
