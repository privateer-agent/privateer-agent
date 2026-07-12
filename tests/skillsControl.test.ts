import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { makeSkillsControl } from "../src/remote/skillsControl.ts";

// skillsControl wraps Pi's loadSkills and writes user SKILL.md files. These tests use
// a throwaway agentDir/cwd so create/list/delete/setEnabled hit the real filesystem in
// isolation (no network, unlike extensionsControl's npm/git paths).

async function tmpControl() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "priv-skills-"));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "work");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  const control = makeSkillsControl({ cwd, agentDir, settingsManager: SettingsManager.inMemory({}) });
  return { control, agentDir, base };
}

test("createSkill writes a SKILL.md with frontmatter + body", async () => {
  const { control, agentDir } = await tmpControl();
  const res = await control.createSkill({ name: "pdf-tools", description: "Work with PDFs", instructions: "Use pdftk." });
  assert.equal(res.ok, true);
  const md = await fs.readFile(path.join(agentDir, "skills", "pdf-tools", "SKILL.md"), "utf8");
  assert.match(md, /^---\n/);
  assert.match(md, /name: "pdf-tools"/);
  assert.match(md, /description: "Work with PDFs"/);
  assert.match(md, /Use pdftk\./);
  assert.doesNotMatch(md, /disable-model-invocation/); // enabled by default
});

test("listSkills surfaces a created skill as editable + enabled", async () => {
  const { control } = await tmpControl();
  await control.createSkill({ name: "brief-me", description: "Daily brief", instructions: "Summarize." });
  const skill = control.listSkills().find((s) => s.name === "brief-me");
  assert.ok(skill, "created skill is listed");
  assert.equal(skill!.editable, true);
  assert.equal(skill!.disabled, false);
  assert.equal(skill!.description, "Daily brief");
});

test("createSkill rejects an invalid name without writing", async () => {
  const { control } = await tmpControl();
  for (const bad of ["PDF Tools", "pdf_tools", "-lead", "trail-", "a".repeat(65), ""]) {
    const res = await control.createSkill({ name: bad, description: "d", instructions: "b" });
    assert.equal(res.ok, false, `"${bad}" should be rejected`);
  }
});

test("createSkill requires a description", async () => {
  const { control } = await tmpControl();
  const res = await control.createSkill({ name: "no-desc", description: "  ", instructions: "b" });
  assert.equal(res.ok, false);
});

test("setEnabled toggles disable-model-invocation in the file", async () => {
  const { control, agentDir } = await tmpControl();
  await control.createSkill({ name: "toggle-me", description: "d", instructions: "b" });
  const file = path.join(agentDir, "skills", "toggle-me", "SKILL.md");

  await control.setEnabled("toggle-me", false);
  let md = await fs.readFile(file, "utf8");
  assert.match(md, /disable-model-invocation: true/);
  assert.equal(control.listSkills().find((s) => s.name === "toggle-me")!.disabled, true);

  await control.setEnabled("toggle-me", true);
  md = await fs.readFile(file, "utf8");
  assert.doesNotMatch(md, /disable-model-invocation/);
  assert.equal(control.listSkills().find((s) => s.name === "toggle-me")!.disabled, false);
});

test("createSkill preserves the disabled state on edit (overwrite)", async () => {
  const { control, agentDir } = await tmpControl();
  await control.createSkill({ name: "keep-off", description: "d", instructions: "one" });
  await control.setEnabled("keep-off", false);
  await control.createSkill({ name: "keep-off", description: "d2", instructions: "two" });
  const md = await fs.readFile(path.join(agentDir, "skills", "keep-off", "SKILL.md"), "utf8");
  assert.match(md, /disable-model-invocation: true/);
  assert.match(md, /description: "d2"/);
  assert.match(md, /two/);
});

test("deleteSkill removes the directory", async () => {
  const { control, agentDir } = await tmpControl();
  await control.createSkill({ name: "gone", description: "d", instructions: "b" });
  const res = await control.deleteSkill("gone");
  assert.equal(res.ok, true);
  await assert.rejects(fs.access(path.join(agentDir, "skills", "gone")));
  assert.equal(control.listSkills().some((s) => s.name === "gone"), false);
});

test("deleteSkill refuses an unknown skill", async () => {
  const { control } = await tmpControl();
  const res = await control.deleteSkill("nope");
  assert.equal(res.ok, false);
});
