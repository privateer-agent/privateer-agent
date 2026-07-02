import type { Routine } from "./schema.ts";
import { writeRoutineOutput, addNotice } from "./store.ts";

// A relay pusher, injected by the daemon. Given the finished result it either
// forwards it to an attached controller immediately ("live") or persists it to the
// pending-relay queue to flush when the app next attaches ("queued"). Either way the
// result is durably accounted for, so delivery doesn't add a notice backstop for it.
export type RelayPusher = (routine: Routine, content: string) => "live" | "queued";

export interface DeliveryContext {
  pushRelay?: RelayPusher;
}

export interface DeliveryReport {
  // Channels that actually delivered (email is handled inside the agent run, so it
  // never appears here — see the daemon).
  delivered: string[];
  // Absolute path to latest.md when file delivery ran.
  filePath?: string;
}

function previewOf(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 120) || "(no output)";
}

// Deliver a routine's result to its configured channels. `file` and `notice` are
// deterministic and on-box. `relay` pushes to an attached controller in real time
// (best-effort — the socket may be up with no controller attached), so we ALSO keep
// a durable record when the routine has no other on-box channel, guaranteeing the
// result is never silently lost. `email` is intentionally not handled here: it is
// fulfilled inside the agent turn (the daemon adds the Gmail tool + an instruction
// to the prompt) so plaintext egress stays an explicit, gated action.
export function deliver(
  routine: Routine,
  content: string,
  status: "ok" | "error",
  ctx: DeliveryContext = {},
): DeliveryReport {
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
  // next attaches (the daemon persists that queue, so it's durable either way). Only
  // when no pusher is wired at all do we fall back to a notice so it isn't lost.
  if (wants.has("relay")) {
    const status = ctx.pushRelay?.(routine, content);
    if (status === "live") delivered.push("relay");
    else if (status === "queued") delivered.push("relay(queued)");
    else if (!wants.has("file") && !wants.has("notice")) {
      leaveNotice();
      delivered.push("notice(backstop)");
    }
  }

  if (wants.has("notice")) {
    leaveNotice();
    delivered.push("notice");
  }

  return { delivered, filePath };
}
