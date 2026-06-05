import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFrontmatter,
  expandCommand,
  loadCustomCommands,
  type CustomCommand,
} from "../src/commands/custom.ts";
import { runCommand } from "../src/commands/registry.ts";
import { Config } from "../src/config/schema.ts";
import { emptyUsage } from "../src/engine/events.ts";

test("parseFrontmatter splits the --- block from the body", () => {
  const raw = "---\ndescription: Open a PR\nargument-hint: <title>\n---\nBody line $1\n";
  const { meta, body } = parseFrontmatter(raw);
  assert.equal(meta.description, "Open a PR");
  assert.equal(meta["argument-hint"], "<title>");
  assert.equal(body.trim(), "Body line $1");
});

test("parseFrontmatter tolerates a body with no frontmatter", () => {
  const { meta, body } = parseFrontmatter("just a prompt $ARGUMENTS");
  assert.deepEqual(meta, {});
  assert.equal(body, "just a prompt $ARGUMENTS");
});

test("expandCommand substitutes positional and full-argument tokens", () => {
  const cmd: CustomCommand = { name: "x", description: "", body: "first=$1 all=$ARGUMENTS at=$@", scope: "project" };
  assert.equal(expandCommand(cmd, "alpha beta"), "first=alpha all=alpha beta at=alpha beta");
  // missing positional → empty
  assert.equal(expandCommand({ ...cmd, body: "[$2]" }, "only"), "[]");
});

test("loadCustomCommands reads project commands, project overrides user", () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const proj = mkdtempSync(join(tmpdir(), "priv-proj-"));
  const prevHome = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    mkdirSync(join(home, "commands"), { recursive: true });
    mkdirSync(join(proj, ".privateer", "commands", "git"), { recursive: true });
    // user-scoped command
    writeFileSync(join(home, "commands", "greet.md"), "say hi", "utf8");
    // project command in a subdir → namespaced name "git:pr"
    writeFileSync(
      join(proj, ".privateer", "commands", "git", "pr.md"),
      "---\ndescription: Draft a PR\n---\nOpen a PR titled $ARGUMENTS",
      "utf8",
    );
    // project command overriding the user "greet"
    writeFileSync(join(proj, ".privateer", "commands", "greet.md"), "project hello", "utf8");

    const cmds = loadCustomCommands(proj);
    const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));
    assert.ok(byName["git:pr"], "namespaced command loads");
    assert.equal(byName["git:pr"].description, "Draft a PR");
    assert.equal(byName["greet"].body, "project hello"); // project wins
    assert.equal(byName["greet"].scope, "project");
  } finally {
    if (prevHome === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("runCommand dispatches an unknown slash command to a custom command", () => {
  const config = Config.parse({});
  const customCommands: CustomCommand[] = [
    { name: "review", description: "Review code", body: "Review the diff for $ARGUMENTS", scope: "project" },
  ];
  const ctx = {
    config,
    modelSpec: "anthropic:claude-opus-4-8",
    mode: "default" as const,
    usage: emptyUsage(),
    cwd: process.cwd(),
    todos: [],
    customCommands,
  };
  const res = runCommand("/review auth flow", ctx);
  assert.ok(res && res.type === "runPrompt");
  assert.equal((res as any).text, "Review the diff for auth flow");

  // Unknown and not custom → error notice.
  const miss = runCommand("/nope", ctx);
  assert.ok(miss && miss.type === "notice" && miss.tone === "error");
});
