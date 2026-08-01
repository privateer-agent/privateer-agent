// Media tools for Pi's TUI: generate images, video, speech and music through the
// signed-in Privateer account, and stitch the results together locally with ffmpeg.
//
// Generation is registered only when the account channel can actually serve it
// (mediaEnabled → signed in, and HARBOR_MEDIA not explicitly off). Omitting the
// factory rather than merely hiding the tools is deliberate: a tool that exists but
// 401s on every call teaches the model to keep retrying, whereas a tool that isn't
// there makes it say "you'd need to sign in" and move on.
//
// video_compose is registered UNCONDITIONALLY. It is local ffmpeg work on files
// already on disk — no account, no network, no spend — so it stays useful to a
// signed-out terminal editing media that came from anywhere.
import { makeMediaTools } from "../src/tools/media.ts";
import { makeComposeTools } from "../src/tools/videoCompose.ts";
import { mediaEnabled } from "../src/config/hosted.ts";

export default function privateerMedia(pi: any): void {
  if (mediaEnabled()) makeMediaTools()(pi);
  makeComposeTools()(pi);
}
