// The two relay file tools as a Pi extension factory bound to ONE specific bridge.
//
// `send_file_to_client` / `save_attachment` are registered by the shipped TUI extension
// (extensions/privateer-gate.ts) against that extension's module-level RemoteBridge — the
// one `/remote-access` attaches a relay to. That is right for the TUI and wrong everywhere
// else: a live task spawn owns its OWN bridge + relay, and the pair must be bound to that.
//
// Hence this factory: a session that has its own bridge registers the pair here. It used
// to also require the gate extension to stand down inside the daemon, because the shared
// agent dir made that extension discoverable into every session the daemon ran — and Pi
// resolves duplicate tool names first-registration-wins, so the discovered pair shadowed
// the session's own and answered "remote access is off" while the app sat attached. The
// moat is no longer discoverable (src/config/moat.ts), so there is only ever one pair.
import { makeSendFileTool, type SendFileBridge } from "./sendFile.ts";
import { makeSaveAttachmentTool } from "./saveAttachment.ts";
import { makeSaveCargoTool, type CargoSaveBridge } from "./cargo.ts";
import type { AttachmentStore } from "../util/attachmentStore.ts";

// save_cargo rides with the file pair rather than with the media tools, because it
// shares their precondition and not media's: it needs a CONNECTED APP, not a signed-in
// account. Registering it in the moat's media block would put it in every harbor and
// channels session, where there is no controller and every call would fail — see
// remote/cargoSave.ts on why unattended runs deliver an artifact a different way.
export function makeRelayFileTools(bridge: SendFileBridge & CargoSaveBridge, attachments: AttachmentStore) {
  return function relayFileTools(pi: any): void {
    pi.registerTool?.(makeSendFileTool(bridge));
    pi.registerTool?.(makeSaveAttachmentTool(attachments));
    pi.registerTool?.(makeSaveCargoTool(bridge));
  };
}
