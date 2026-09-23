// Vision delegation: when the current model can't see images, a vision model on the
// same provider (same key) describes them, and the description is what gets sent.
// All the policy — which delegate, why never another provider, what gets rewritten —
// lives in src/providers/visionDelegate.ts; this file is only the Pi wiring.
//
// It hooks `context`, which runs before EVERY LLM call on a per-request copy of the
// messages, rather than `input`/`tool_result`. That catches images from every source
// (@file mentions, pasted images, `read`, media and computer tools, MCP results, and
// history from before a /model switch) while leaving the session's own copy intact.
// Descriptions are cached by image hash, so each image costs one delegate call per
// process, not one per turn.

import { describeImagesInMessages, pickVisionDelegate } from "../src/providers/visionDelegate.ts";

export default function privateerVision(pi: any): void {
  const announced = new Set<string>();

  pi.on("context", async (event: any, ctx: any) => {
    const model = ctx?.model;
    const registry = ctx?.modelRegistry;
    if (!model || !registry) return;
    const delegate = pickVisionDelegate(model, registry);
    if (!delegate) return;

    const currentSpec = `${model.provider}/${model.id}`;
    const delegateSpec = `${delegate.provider}/${delegate.id}`;
    const messages = await describeImagesInMessages(event.messages, delegate, registry, {
      currentSpec,
      signal: ctx.signal,
      onDescribe: () => {
        const key = `${currentSpec}→${delegateSpec}`;
        if (announced.has(key) || !ctx.hasUI) return;
        announced.add(key);
        ctx.ui.notify(`${currentSpec} can't see images — ${delegateSpec} will describe them for it.`, "info");
      },
    });
    return messages ? { messages } : undefined;
  });
}
