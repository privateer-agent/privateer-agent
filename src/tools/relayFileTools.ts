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
import { makeChartTools, type ChartOpBridge } from "./charts.ts";
import { makeSaveToLibraryTool, type LibrarySaveBridge } from "./saveToLibrary.ts";
import type { AttachmentStore } from "../util/attachmentStore.ts";

// save_cargo rides with the file pair rather than with the media tools, because it
// shares their precondition and not media's: it needs a CONNECTED APP, not a signed-in
// account. Registering it in the moat's media block would put it in every harbor and
// channels session, where there is no controller and every call would fail — see
// remote/cargoSave.ts on why unattended runs deliver an artifact a different way.
// save_to_library rides here for save_cargo's reason exactly — it needs a CONNECTED
// APP rather than a signed-in account, because only the app holds the master key that
// a Library row's ciphertext is under. Putting it in the moat's media block would give
// it to every harbor and channels session, where there is no controller and every call
// would fail; an unattended run already delivers a file a different way, as a sealed
// attachment on its Inbox result (routines/resultMedia.ts).
// The chart tools ride here too, for the same reason save_cargo does and one more of
// their own. Same reason: they need a CONNECTED APP, not a signed-in account, so the
// moat's media block would put them in every harbor and channels session where there is
// no controller and every call would fail. Their own reason: unlike cargo they also READ
// the user's stored content, so an unattended session that could call them would be a
// terminal asking for decrypted chat content with nobody watching the request.
export function makeRelayFileTools(
  bridge: SendFileBridge & CargoSaveBridge & ChartOpBridge & LibrarySaveBridge,
  attachments: AttachmentStore,
) {
  return function relayFileTools(pi: any): void {
    pi.registerTool?.(makeSendFileTool(bridge));
    pi.registerTool?.(makeSaveAttachmentTool(attachments));
    pi.registerTool?.(makeSaveCargoTool(bridge));
    pi.registerTool?.(makeSaveToLibraryTool(bridge));
    for (const tool of makeChartTools(bridge)) pi.registerTool?.(tool);
  };
}
