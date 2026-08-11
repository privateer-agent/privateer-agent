// The delivery brief — what an unattended run is told about where its answer lands.
//
// A routine's prompt is written by the user ("summarise my open PRs at 7am"). It says
// what to do and nothing about the surface, so the model wrote for a terminal: paths,
// scrollback references, "see above", a plan to run something else next. None of that
// survives the trip. The result is sealed to the account outbox and read hours later
// in the app's Inbox, by someone who was not there and cannot answer back.
//
// So we prepend this. It states the surface (markdown, in an app), what the surface can
// render beyond prose (ONE fenced artifact, which the app turns into a Cargo card with
// Preview / Download / Save), and how to hand over media (the attach_to_result tool —
// only mentioned when it is actually registered, because a brief that advertises a tool
// the run doesn't have is how a model ends up describing an attachment nobody gets).
//
// Deliberately short. It is prepended to every unattended turn, so every line costs
// tokens on every run; anything that isn't load-bearing for the delivery is the user's
// prompt's business, not ours.

export interface BriefOptions {
  /** The result reaches the app's Inbox (cloud delivery). False → no brief at all. */
  inbox: boolean;
  /** attach_to_result is registered for this run. */
  canAttach: boolean;
}

const HEADER = "[Privateer delivery brief — how this answer will be read]";

/**
 * The brief for one run, or "" when it wouldn't help. Callers prepend it with
 * `withBrief` rather than concatenating by hand.
 */
export function deliveryBrief(opts: BriefOptions): string {
  if (!opts.inbox) return "";
  const lines = [
    HEADER,
    "Nobody is at this terminal. Your final message is delivered to the user's Privateer Inbox in the app and read later, on a phone or in a browser, with no access to this machine.",
    "",
    "- Write the answer so it stands alone. No scrollback, no \"see above\", no next step you meant to run.",
    "- It renders as Markdown: headings, lists, tables, links and code all work.",
    "- A local file path is not something the user can open. Don't offer one as the way to see something.",
    "- If the answer is better as something they can keep, open or share, end your message with ONE fenced artifact and describe it in prose above:",
    "    ```html … ```               a complete standalone HTML document — page, slide deck or game. Inline all CSS and JS; it is opened with no network and no sibling files.",
    "    ```md kind=pdf … ```        a document (also kind=docx, kind=md).",
    "    ```csv kind=sheet … ```     a spreadsheet.",
    "  The app turns that fence into an artifact card with Preview, Download and Save — so don't also paste the same content as prose.",
  ];
  if (opts.canAttach) {
    lines.push(
      "- To send an image, video, audio clip or document, call attach_to_result with its path. That is the only way bytes reach the user; base64 pasted into the answer is not rendered.",
    );
  }
  return lines.join("\n");
}

/** Prepend the brief to a user prompt, fenced off so the two don't read as one instruction. */
export function withBrief(prompt: string, opts: BriefOptions): string {
  const brief = deliveryBrief(opts);
  if (!brief) return prompt;
  return `${brief}\n\n---\n\n${prompt}`;
}
