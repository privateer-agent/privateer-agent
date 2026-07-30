// The two relay file tools as a Pi extension factory bound to ONE specific bridge.
//
// `send_file_to_client` / `save_attachment` are normally registered by the shipped TUI
// extension (extensions/privateer-gate.ts), against that extension's module-level
// RemoteBridge — the one `/remote-access` attaches a relay to. That is right for the TUI
// and wrong everywhere else: the extension is AUTO-DISCOVERED from ~/.privateer/agent/
// extensions into every session that shares the agent dir, including the sessions the
// harbor daemon stands up (live task spawns), which own their OWN bridge + relay. Pi
// resolves duplicate tool names first-registration-wins and loads discovered extensions
// before inline factories, so the discovered pair would shadow a session's own and answer
// "remote access is off" while the session's relay is connected and driving.
//
// Hence this factory: a session that has its own bridge registers the pair here, and the
// gate extension stands down inside the daemon (PRIVATEER_HARBOR_DAEMON).
import { makeSendFileTool, type SendFileBridge } from "./sendFile.ts";
import { makeSaveAttachmentTool } from "./saveAttachment.ts";
import type { AttachmentStore } from "../util/attachmentStore.ts";

export function makeRelayFileTools(bridge: SendFileBridge, attachments: AttachmentStore) {
  return function relayFileTools(pi: any): void {
    pi.registerTool?.(makeSendFileTool(bridge));
    pi.registerTool?.(makeSaveAttachmentTool(attachments));
  };
}
