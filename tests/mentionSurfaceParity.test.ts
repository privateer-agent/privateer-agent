import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// `@file` mentions are a TWO-part feature, and both parts live on the terminal:
//
//   • files_search → file_matches — the app composer's `@` palette. The app cannot
//     list a machine it isn't on, so an unanswered frame times out to [] after 4s
//     (client/contexts/RemoteDriveContext.tsx searchFiles) and the palette reads
//     "no files" — indistinguishable from an empty project.
//   • resolveMentions at submit — the picked path becomes a <file> block (or a real
//     image attachment) appended to the prompt.
//
// Three surfaces can be driven from the app, and for months only two of them had
// either half. src/cli/chat.ts (the dev REPL) and desktop's agentSession.ts both wired
// it; extensions/privateer-gate.ts — the extension the SHIPPED TUI runs, and therefore
// the one every `privateer` terminal on a phone is actually talking to — wired neither.
// Nothing failed loudly: the palette looked like an empty project and the prompt still
// "worked", because the model read the path with its own Read tool. The only trace was
// that no session transcript ever contained a <file> block.
//
// Both surfaces register the same label ("privateer-cli"), so the drift was invisible
// from the app too. This test is the thing that makes it visible: a new driven surface,
// or a refactor that drops a callback, fails here instead of degrading silently.

const REPO = resolve(import.meta.dirname, "..");

// Each entry is a surface that builds a RemoteBridge and can be driven from the app.
// Add one here when you add one there — that is the point of the test.
const SURFACES: Array<{ file: string; what: string }> = [
  { file: "src/cli/chat.ts", what: "the dev REPL" },
  { file: "extensions/privateer-gate.ts", what: "the shipped Pi TUI" },
];

for (const { file, what } of SURFACES) {
  test(`@file mentions: ${file} (${what}) answers the palette and expands at submit`, () => {
    const src = readFileSync(resolve(REPO, file), "utf-8");

    // Sanity: this file really is a driven surface, so a rename can't turn the test
    // into a vacuous pass.
    assert.match(src, /new RemoteBridge\(/, `${file} no longer builds a RemoteBridge — is the SURFACES list stale?`);

    assert.match(
      src,
      /onFilesSearch\s*:/,
      `${file} builds a RemoteBridge but never answers files_search — the app's @ palette will sit empty on this terminal.`,
    );
    assert.match(
      src,
      /sendFileMatches\(/,
      `${file} declares onFilesSearch but never replies with sendFileMatches — the app times out to [] after 4s.`,
    );
    assert.match(
      src,
      /resolveMentions\(/,
      `${file} never expands @path mentions — a referenced file reaches the model as a bare path, with no <file> block and no image attachment.`,
    );

    // The cwd strip in the app composer is the only place a driver can see which
    // folder their prompts read, write and @-mention against. It rides on `context`
    // and nothing else sends it.
    assert.match(
      src,
      /sendContext\(\{[^}]*\bcwd\b/,
      `${file} never sends cwd on its context frame — the app composer shows no working-directory strip for this terminal.`,
    );
  });
}

// The desktop app's own session is the third surface. It lives in the treeview repo,
// so it is only checked when both repos are checked out side by side — skipped, never
// failed, when it isn't there.
test("@file mentions: the desktop session keeps parity too", (t) => {
  const p = resolve(REPO, "../treeview/desktop/src/main/agentSession.ts");
  if (!existsSync(p)) return t.skip("treeview not checked out beside privateer-agent");
  const src = readFileSync(p, "utf-8");
  assert.match(src, /onFilesSearch\s*:/, "desktop agentSession no longer answers files_search");
  assert.match(src, /resolveMentions\(/, "desktop agentSession no longer expands @path mentions");
});
