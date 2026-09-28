// Who the model thinks it is, and which command it reaches for.
//
// THE PROBLEM. Pi's stock system prompt opens "You are an expert coding assistant
// operating inside pi" and points the model at Pi's own README for questions about
// "pi itself" — a README that documents `pi -p`. So an agent asked to run a one-shot
// job, script itself, or hand work to another agent process typed `pi -p "…"`. That is
// not a cosmetic slip: bare `pi` runs with none of the moat — no permission gate, no
// --allow-spend / --approve-in-app, no privacy routing, no account — so the one
// invocation that most needs the spending gate was the one that skipped it.
//
// THE FIX. Rewrite Pi's self-description to name Privateer, relabel the Pi docs as the
// SDK docs they are (still the right reference for writing extensions), and append a
// short block stating the CLI the model must use. Registered on every surface: the
// discovered privateer-context shim (TUI, -p, subagent children, desktop) and the
// in-code moat for kinds that don't load that shim (src/config/moat.ts).
//
// Same "append, or say nothing" contract as privateer-context: a host that hands us no
// prompt string gets no rewrite, and a prompt already carrying the marker is left alone.

export const IDENTITY_MARKER = "<!-- privateer:identity -->";

const PI_PREAMBLE = "operating inside pi, a coding agent harness.";
const PI_DOCS_HEADER =
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";

export function privateerCliBlock(cmd: string = process.env.PRIVATEER_CMD || "privateer"): string {
  return `\n\n${IDENTITY_MARKER}\n<privateer_cli>
You are running inside Privateer; its command is \`${cmd}\`. Privateer is built on the Pi SDK, but \`pi\` is NOT a command you may use: never run \`pi\`, \`pi -p\` or any other \`pi …\` invocation. It bypasses Privateer's permission gate, spending caps, privacy routing and account. Wherever Pi's docs show \`pi\`, the command here is \`${cmd}\`.
- One-shot / headless run (a script, a cron job, handing a task to a separate agent process): \`${cmd} -p "…"\`. It has no screen, so anything that needs approval is DENIED, including every billed media tool.
- Let that run spend on named billed tools, capped: \`${cmd} -p --allow-spend <tool[,tool…]> --max-calls <n> [--max-spend <usd>] "…"\`
- Or send each approval to the user's Privateer app: \`${cmd} -p --approve-in-app [--approval-timeout <seconds>] "…"\`
- A program that must answer approvals itself drives Privateer over ACP: \`${cmd} acp\`.
- For a sub-task inside this session, use a subagent tool if one is available rather than shelling out to a new process.
</privateer_cli>\n`;
}

/** Rewrite Pi's self-description and append the CLI block. Returns `prompt` unchanged when already applied. */
export function applyIdentity(prompt: string, cmd?: string): string {
  if (prompt.includes(IDENTITY_MARKER)) return prompt;
  const out = prompt
    .replace(PI_PREAMBLE, "operating inside Privateer, a privacy-first coding agent built on the Pi SDK.")
    .replace(
      PI_DOCS_HEADER,
      "Pi SDK documentation (Privateer is built on Pi; read only when asked about writing extensions, themes, skills, prompt templates or TUI components — every `pi` command in these docs is `privateer` here):",
    );
  return out + privateerCliBlock(cmd);
}

/** A before_agent_start extension that applies the identity rewrite. */
export default function privateerIdentity(pi: any): void {
  pi.on("before_agent_start", (event: any) => {
    const base = event?.systemPrompt;
    if (typeof base !== "string") return;
    const prompt = applyIdentity(base);
    if (prompt === base) return;
    return { systemPrompt: prompt };
  });
}
