import type { Routine } from "./schema.ts";
import { writeRoutineOutput, addNotice } from "./store.ts";

// A relay pusher, injected by the daemon when a controller is attached. Given the
// finished result, it forwards it to the user's own devices over the relay. Absent
// when nothing is connected — relay delivery then degrades to a notice.
export type RelayPusher = (routine: Routine, content: string) => boolean;

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
// deterministic and on-box; `relay` uses the injected pusher and falls back to a
// notice when no controller is attached. `email` is intentionally not handled here:
// it is fulfilled inside the agent turn (the daemon adds the Gmail tool + an
// instruction to the prompt) so plaintext egress stays an explicit, gated action.
export function deliver(
  routine: Routine,
  content: string,
  status: "ok" | "error",
  ctx: DeliveryContext = {},
): DeliveryReport {
  const delivered: string[] = [];
  let filePath: string | undefined;

  // Always keep an on-box copy when `file` is requested (and as a safety net for
  // relay's fallback notice to point at).
  if (routine.delivery.includes("file")) {
    filePath = writeRoutineOutput(routine.name, content);
    delivered.push("file");
  }

  if (routine.delivery.includes("relay")) {
    const pushed = ctx.pushRelay?.(routine, content) ?? false;
    if (pushed) delivered.push("relay");
    else if (!routine.delivery.includes("notice")) {
      // No controller attached — leave a notice so the result isn't lost.
      addNotice({ routine: routine.name, at: new Date().toISOString(), status, preview: previewOf(content), path: filePath });
      delivered.push("notice(relay-fallback)");
    }
  }

  if (routine.delivery.includes("notice")) {
    addNotice({ routine: routine.name, at: new Date().toISOString(), status, preview: previewOf(content), path: filePath });
    delivered.push("notice");
  }

  return { delivered, filePath };
}
