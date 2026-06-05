import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOutputStyles, findOutputStyle } from "../src/context/outputStyles.ts";
import { buildSystemPrompt } from "../src/context/systemPrompt.ts";

function withProject(fn: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "priv-style-"));
  const prevHome = process.env.PRIVATEER_HOME;
  // Isolate global dir so a developer's real ~/.privateer styles don't leak in.
  process.env.PRIVATEER_HOME = mkdtempSync(join(tmpdir(), "priv-home-"));
  try {
    fn(cwd);
  } finally {
    rmSync(process.env.PRIVATEER_HOME!, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prevHome;
    rmSync(cwd, { recursive: true, force: true });
  }
}

function writeStyle(cwd: string, name: string, content: string): void {
  const dir = join(cwd, ".privateer", "output-styles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, "utf8");
}

test("loadOutputStyles reads styles with frontmatter from the project dir", () => {
  withProject((cwd) => {
    writeStyle(cwd, "terse", "---\ndescription: Ultra terse\n---\nAnswer in one line. No prose.");
    const styles = loadOutputStyles(cwd);
    assert.equal(styles.length, 1);
    assert.equal(styles[0].name, "terse");
    assert.equal(styles[0].description, "Ultra terse");
    assert.match(styles[0].body, /Answer in one line/);
    assert.ok(findOutputStyle("terse", cwd));
    assert.equal(findOutputStyle("missing", cwd), undefined);
  });
});

test("buildSystemPrompt swaps in the output-style body for the tone section", () => {
  const base = buildSystemPrompt({ cwd: process.cwd(), model: "anthropic:claude-opus-4-8" });
  assert.match(base, /Tone and style/); // default persona present

  const styled = buildSystemPrompt({
    cwd: process.cwd(),
    model: "anthropic:claude-opus-4-8",
    outputStyleBody: "PIRATE MODE: answer like a salty privateer.",
  });
  assert.match(styled, /PIRATE MODE/);
  assert.doesNotMatch(styled, /Tone and style/); // default tone replaced
  // Tool policy and identity remain regardless of style.
  assert.match(styled, /Using your tools/);
  assert.match(styled, /You are Privateer/);
});
