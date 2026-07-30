// Pure ACP <-> Privateer mappings.
//
// Everything here is a total function over plain data: no connection, no Pi, no
// clock. That's what makes tests/acp.test.ts able to pin the wire contract without
// spawning an agent or a relay — the same split that keeps `messageFromDiscord`
// testable apart from the Discord socket.
//
// The shapes come from @zed-industries/agent-client-protocol (the protocol authors'
// own package), NOT from prose docs. That distinction already mattered twice:
// the published docs claimed `stopReason: "Completed"` and a `channel_id` tag, and
// both were wrong. Types win; prose loses.

import type { ContentBlock, PermissionOption, RequestPermissionResponse } from "@zed-industries/agent-client-protocol";
import type { AskOutcome } from "../permissions/modeGate.ts";
import type { PermissionRequest } from "../permissions/gate.ts";
import { isDangerousCommand, DEFAULT_DENYLIST } from "../permissions/danger.ts";

/**
 * Flatten ACP content blocks into the single string Pi's `session.prompt` takes.
 *
 * We advertise only the block kinds we can faithfully represent (see
 * PROMPT_CAPABILITIES). Anything richer that arrives anyway is rendered as a
 * labelled placeholder rather than dropped — silently discarding part of a user's
 * message is worse than telling the model something was attached.
 */
export function promptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks ?? []) {
    switch (b.type) {
      case "text":
        parts.push(b.text);
        break;
      case "resource_link":
        // A pointer to something the agent can open with its own tools.
        parts.push(`[resource: ${b.name ?? b.uri}](${b.uri})`);
        break;
      case "resource": {
        // Embedded context — the client inlined the bytes so we need no round-trip.
        const r: any = b.resource;
        if (typeof r?.text === "string") {
          parts.push(r.uri ? `<resource uri="${r.uri}">\n${r.text}\n</resource>` : r.text);
        } else if (r?.uri) {
          parts.push(`[resource: ${r.uri}]`);
        }
        break;
      }
      case "image":
        parts.push(`[image attached: ${(b as any).mimeType ?? "image"}]`);
        break;
      case "audio":
        parts.push(`[audio attached: ${(b as any).mimeType ?? "audio"}]`);
        break;
      default:
        parts.push(`[unsupported content block: ${(b as any)?.type ?? "unknown"}]`);
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * May this decision be remembered for the rest of the session?
 *
 * The gate has TWO destructive classes and only one of them is visible on the
 * request. `alwaysAsk`/`protected` are fields; **dangerous shell** (`rm -rf`,
 * `curl … | sh`, `dd of=/dev/…`, force-push to main, secret-exfil shapes) is
 * computed inside `decideAuto` and never stamped back onto the request. Checking
 * only the fields therefore let a dangerous command be cached, which is precisely
 * what ModeGate refuses to do locally:
 *
 *   "A dangerous command … can be approved once, but is never remembered: adding
 *    it to the allowlist or relaxing the mode would let a later variant slip
 *    through."  — permissions/modeGate.ts
 *
 * On the ACP path `getRemote()` is always true, so ModeGate's remote branch returns
 * before that check ever runs — this predicate is the only thing enforcing it. Used
 * by BOTH the option list and the cache write so the two can't drift apart.
 *
 * `DEFAULT_DENYLIST` is the right default here: src/acp/run.ts sets no
 * `ctrl.denylist`, and permissionGate.ts falls back to exactly this list.
 */
export function canRemember(req: PermissionRequest, denylist: string[] = DEFAULT_DENYLIST): boolean {
  if (req.alwaysAsk || req.protected) return false;
  if (req.kind === "bash" && isDangerousCommand(req.detail ?? "", denylist)) return false;
  return true;
}

/**
 * The choices we offer a human for one gated action.
 *
 * "always" is withheld for anything `canRemember` rejects — a destructive action, a
 * guarded file, or a dangerous shell command must never become standing permission,
 * which is the same rule the TUI and the relay enforce. Offering the option and then
 * ignoring it would be worse than not offering it.
 */
export function permissionOptions(req: PermissionRequest): PermissionOption[] {
  const sticky = canRemember(req);
  const options: PermissionOption[] = [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
  if (sticky) options.push({ optionId: "always", name: "Allow for the rest of this session", kind: "allow_always" });
  options.push({ optionId: "deny", name: "Deny", kind: "reject_once" });
  return options;
}

/**
 * Map the client's answer back to a gate outcome. FAIL-CLOSED: anything we don't
 * recognize — a cancelled prompt, an option id we never offered, a malformed
 * response — is a denial. An ambiguous answer must never widen permission.
 */
export function outcomeToAsk(res: RequestPermissionResponse | undefined): AskOutcome {
  const outcome = res?.outcome;
  if (!outcome || outcome.outcome !== "selected") return "deny";
  switch (outcome.optionId) {
    case "allow":
      return "allow";
    case "always":
      return "always";
    default:
      return "deny";
  }
}

/** A one-line human summary of a gated action, for the client's permission UI. */
export function permissionTitle(req: PermissionRequest): string {
  const detail = req.detail?.trim() ?? "";
  const firstLine = detail.split("\n")[0]?.slice(0, 120) ?? "";
  return firstLine ? `${req.title} — ${firstLine}` : req.title;
}

/** Privateer's permission kinds, in ACP's vocabulary. Exhaustive over PermissionKind
 *  ("write" | "edit" | "bash" | "fetch" | "read"), so adding a kind is a type error
 *  here rather than a silent "other" in someone's approval dialog. */
export function toolKindFor(req: PermissionRequest): "read" | "edit" | "execute" | "fetch" | "other" {
  switch (req.kind) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "execute";
    case "fetch":
      return "fetch";
    default:
      return "other";
  }
}
