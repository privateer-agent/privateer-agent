import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../src/commands/custom.ts";
import { loadSkills, findSkill } from "../src/skills/loader.ts";
import { skillTool } from "../src/tools/skill.ts";
import { runCommand, commandList } from "../src/commands/registry.ts";
import { autoApproveGate } from "../src/permissions/gate.ts";
import type { ToolContext } from "../src/tools/context.ts";
import { Config } from "../src/config/schema.ts";
import { emptyUsage } from "../src/engine/events.ts";

// --- fixtures ---------------------------------------------------------------

function withScopes(fn: (home: string, proj: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const proj = mkdtempSync(join(tmpdir(), "priv-proj-"));
  const prevHome = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    fn(home, proj);
  } finally {
    if (prevHome === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

function writeSkill(root: string, dirName: string, frontmatter: string, body = "Do the thing.") {
  const dir = join(root, "skills", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  return dir;
}

// --- parseFrontmatter extensions ---------------------------------------------

test("parseFrontmatter handles folded block scalars", () => {
  const raw = "---\ndescription: >-\n  Fill, merge, and extract\n  PDF forms.\nname: pdf\n---\nbody";
  const { meta, body } = parseFrontmatter(raw);
  assert.equal(meta.description, "Fill, merge, and extract PDF forms.");
  assert.equal(meta.name, "pdf");
  assert.equal(body.trim(), "body");
});

test("parseFrontmatter handles literal block scalars", () => {
  const raw = "---\nnotes: |\n  line one\n  line two\n---\n";
  const { meta } = parseFrontmatter(raw);
  assert.equal(meta.notes, "line one\nline two");
});

test("parseFrontmatter handles indented continuation lines", () => {
  const raw = "---\ndescription: Fill PDF forms.\n  Use when working with PDFs.\n---\n";
  const { meta } = parseFrontmatter(raw);
  assert.equal(meta.description, "Fill PDF forms. Use when working with PDFs.");
});

test("parseFrontmatter strips matching quotes", () => {
  const raw = '---\nname: "pdf-tools"\ndescription: \'It is quoted\'\n---\n';
  const { meta } = parseFrontmatter(raw);
  assert.equal(meta.name, "pdf-tools");
  assert.equal(meta.description, "It is quoted");
});

test("parseFrontmatter flat frontmatter is unchanged", () => {
  const raw = "---\ndescription: Open a PR\nargument-hint: <title>\n---\nBody line $1\n";
  const { meta, body } = parseFrontmatter(raw);
  assert.equal(meta.description, "Open a PR");
  assert.equal(meta["argument-hint"], "<title>");
  assert.equal(body.trim(), "Body line $1");
});

// --- loader -------------------------------------------------------------------

test("loadSkills loads both scopes, project overrides user", () => {
  withScopes((home, proj) => {
    writeSkill(home, "greet", "name: greet\ndescription: user greeting");
    writeSkill(join(proj, ".privateer"), "greet", "name: greet\ndescription: project greeting");
    writeSkill(join(proj, ".privateer"), "pdf-tools", "description: Work with PDFs");
    const { skills } = loadSkills(proj);
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    assert.equal(byName["greet"].scope, "project");
    assert.equal(byName["greet"].description, "project greeting");
    assert.equal(byName["pdf-tools"].name, "pdf-tools"); // falls back to dir name
    assert.ok(byName["pdf-tools"].dir.endsWith(join("skills", "pdf-tools")));
  });
});

test("loadSkills skips invalid skills with warnings", () => {
  withScopes((home, proj) => {
    writeSkill(join(proj, ".privateer"), "no-desc", "name: no-desc"); // missing description
    writeSkill(join(proj, ".privateer"), "ok", "description: fine");
    writeSkill(join(proj, ".privateer"), "Bad_Name!", "description: x"); // invalid name
    // A directory without SKILL.md is ignored silently.
    mkdirSync(join(proj, ".privateer", "skills", "empty"), { recursive: true });
    const { skills, warnings } = loadSkills(proj);
    assert.deepEqual(skills.map((s) => s.name), ["ok"]);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((w) => w.includes("missing description")));
    assert.ok(warnings.some((w) => w.includes("invalid name")));
  });
});

test("loadSkills parses allowed-tools and model; findSkill resolves", () => {
  withScopes((_home, proj) => {
    writeSkill(
      join(proj, ".privateer"),
      "deploy",
      "description: Deploy the app\nallowed-tools: bash, read\nmodel: anthropic:claude-opus-4-8",
    );
    const skill = findSkill("deploy", proj);
    assert.ok(skill);
    assert.deepEqual(skill.allowedTools, ["bash", "read"]);
    assert.equal(skill.model, "anthropic:claude-opus-4-8");
    assert.equal(skill.body, "Do the thing.");
  });
});

// --- skill tool ----------------------------------------------------------------

function toolCtx(cwd: string): ToolContext {
  return { cwd, gate: autoApproveGate, allowedOutsideRoots: [] };
}

test("skillTool embeds the catalog and loads a skill body", async () => {
  withScopes((_home, proj) => {
    const dir = writeSkill(
      join(proj, ".privateer"),
      "pdf-tools",
      "description: Fill and merge PDFs\nallowed-tools: bash",
      "# PDF Tools\nUse scripts/fill.py.",
    );
    const ctx = toolCtx(proj);
    const t = skillTool(ctx, loadSkills(proj).skills);
    assert.ok((t as any).description.includes("- pdf-tools: Fill and merge PDFs"));
    return (t as any)
      .execute({ skill: "pdf-tools" }, { toolCallId: "t1", messages: [] })
      .then((out: string) => {
        assert.ok(out.includes(`base directory: ${dir}`));
        assert.ok(out.includes("# PDF Tools"));
        assert.ok(out.includes("allowed-tools: bash"));
        // Loading unlocks bundled-file reads under the skill dir.
        assert.ok(ctx.allowedOutsideRoots!.includes(dir));
      });
  });
});

test("skillTool reports unknown skills with the available list", async () => {
  withScopes((_home, proj) => {
    writeSkill(join(proj, ".privateer"), "ok", "description: fine");
    const t = skillTool(toolCtx(proj), loadSkills(proj).skills);
    return (t as any)
      .execute({ skill: "nope" }, { toolCallId: "t1", messages: [] })
      .then((out: string) => {
        assert.ok(out.includes('No skill named "nope"'));
        assert.ok(out.includes("ok"));
      });
  });
});

// --- slash integration -----------------------------------------------------------

function cmdCtx(cwd: string, skills: ReturnType<typeof loadSkills>["skills"]) {
  return {
    config: Config.parse({}),
    modelSpec: "anthropic:claude-opus-4-8",
    mode: "default" as const,
    usage: emptyUsage(),
    cwd,
    todos: [],
    customCommands: [],
    skills,
  };
}

test("/skill-name expands to a prompt that invokes the skill tool", () => {
  withScopes((_home, proj) => {
    writeSkill(join(proj, ".privateer"), "pdf-tools", "description: PDFs");
    const ctx = cmdCtx(proj, loadSkills(proj).skills);
    const res = runCommand("/pdf-tools fill out tax form", ctx);
    assert.ok(res && res.type === "runPrompt");
    assert.ok((res as any).text.includes('"pdf-tools" skill with the skill tool'));
    assert.ok((res as any).text.includes("fill out tax form"));
    const bare = runCommand("/pdf-tools", ctx);
    assert.ok(bare && bare.type === "runPrompt");
  });
});

test("a custom command shadows a same-named skill", () => {
  withScopes((_home, proj) => {
    writeSkill(join(proj, ".privateer"), "review", "description: skill review");
    const ctx = {
      ...cmdCtx(proj, loadSkills(proj).skills),
      customCommands: [{ name: "review", description: "cmd", body: "custom body", scope: "project" as const }],
    };
    const res = runCommand("/review", ctx);
    assert.ok(res && res.type === "runPrompt");
    assert.equal((res as any).text, "custom body");
  });
});

test("/skills lists skills and warnings; install/remove return skillOp", () => {
  withScopes((_home, proj) => {
    writeSkill(join(proj, ".privateer"), "ok", "description: fine");
    writeSkill(join(proj, ".privateer"), "no-desc", "name: no-desc");
    const ctx = cmdCtx(proj, loadSkills(proj).skills);
    const list = runCommand("/skills", ctx);
    assert.ok(list && list.type === "notice");
    assert.ok((list as any).text.includes("ok (project)"));
    assert.ok((list as any).text.includes("Warnings:"));

    const info = runCommand("/skills info ok", ctx);
    assert.ok(info && info.type === "notice");
    assert.ok((info as any).text.includes("Do the thing."));

    const inst = runCommand("/skills install anthropics/skills/x --project --force", ctx);
    assert.deepEqual(inst, {
      type: "skillOp",
      op: "install",
      arg: "anthropics/skills/x",
      project: true,
      all: false,
      force: true,
    });

    const rm = runCommand("/skills remove ok", ctx);
    assert.deepEqual(rm, { type: "skillOp", op: "remove", arg: "ok", project: false });

    const bad = runCommand("/skills install", ctx);
    assert.ok(bad && bad.type === "notice" && (bad as any).tone === "error");
  });
});

test("commandList appends skills to autocomplete", () => {
  withScopes((_home, proj) => {
    writeSkill(join(proj, ".privateer"), "pdf-tools", "description: PDFs\n  and more");
    const list = commandList([], loadSkills(proj).skills);
    const entry = list.find((c) => c.name === "pdf-tools");
    assert.ok(entry);
    assert.equal(entry.summary, "skill — PDFs and more");
  });
});
