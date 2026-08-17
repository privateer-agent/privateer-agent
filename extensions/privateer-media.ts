// Media tools for Pi's TUI: generate images, video, 3D meshes, speech, music and
// sound effects through the signed-in Privateer account, and stitch the results
// together locally with ffmpeg.
//
// Generation is registered only when the account channel can actually serve it
// (mediaEnabled → signed in, and HARBOR_MEDIA not explicitly off). Omitting the
// factory rather than merely hiding the tools is deliberate: a tool that exists but
// 401s on every call teaches the model to keep retrying, whereas a tool that isn't
// there makes it say "you'd need to sign in" and move on.
//
// A SUBAGENT CHILD is held to the same rule for the same reason, one step further out.
// A child is a headless process with nobody to approve a billing call, so unless its
// parent handed down a spend grant (src/permissions/childSpend.ts — an unattended run
// passing on the media tools its own allow-list names), every generate_* call it made
// would be denied by the gate. Registering them anyway would spend the child's whole
// context discovering that one refusal at a time. So an ungranted child gets no
// generation tools and reports the truth: it can compose, not generate.
//
// video_compose is registered UNCONDITIONALLY. It is local ffmpeg work on files
// already on disk — no account, no network, no spend — so it stays useful to a
// signed-out terminal, and to a child whose job is to cut together what its parent
// generated.
import { makeMediaTools } from "../src/tools/media.ts";
import { makeComposeTools } from "../src/tools/videoCompose.ts";
import { mediaEnabled } from "../src/config/hosted.ts";
import { childHoldsSpendGrant } from "../src/permissions/childSpend.ts";
import { isSubagentChild } from "../src/remote/subagentRelay.ts";

export default function privateerMedia(pi: any): void {
  const canSpend = !isSubagentChild() || childHoldsSpendGrant();
  if (mediaEnabled() && canSpend) makeMediaTools()(pi);
  makeComposeTools()(pi);
}
