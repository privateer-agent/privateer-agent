// Which half of `privateer update` did the user mean?
//
// "update" used to mean ONE thing — replace the CLI — and the launcher swallowed every
// flag after it. So `privateer update --extensions`, the command Pi's own startup banner
// told people to run (as `pi update --extensions`, naming a binary that is installed
// nowhere on a Privateer machine), silently reinstalled the CLI instead of fetching the
// tool pack that had an update waiting. Splitting the verb the way Pi's own grammar
// already does is the fix; this is the decision, kept apart from the launcher so it can
// be tested without spawning anything (tests/updates.test.ts).
//
//   privateer update                              → "self"   (unchanged: the common case)
//   privateer update --self | self | pi           → "self"
//   privateer update --extensions                 → "packs"
//   privateer update <pack> | --extension <pack>  → "packs"
//   privateer update --all                        → "all"    (packs, then the CLI)
//
// "all" is deliberately not Pi's "--all": to Pi that includes updating pi-coding-agent
// globally via npm, which is not how this CLI is installed. Ours means tool packs plus
// `privateer update`, so the launcher translates it and chains the self-update after.

/**
 * @param {string[]} rest — argv after the `update` subcommand
 * @returns {"self" | "packs" | "all" | "help"}
 */
export function routeUpdate(rest) {
  const args = rest ?? [];
  // `update --help` must not fall through to "no pack flags → update the CLI", which
  // would answer a question by reinstalling the program.
  if (args.includes("--help") || args.includes("-h")) return "help";
  if (args.includes("--all")) return "all";
  // A bare word that isn't "self"/"pi" is a pack name (Pi's positional source form).
  const namesPack = args.some((a) => !a.startsWith("-") && a !== "self" && a !== "pi");
  if (args.includes("--extensions") || args.includes("--extension") || namesPack) return "packs";
  return "self";
}
