import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The dual project-config-dir patch: a project may configure Privateer in
// `.privateer/` as well as Pi's `.pi/`, and `.privateer` supersedes on conflict.
//
// Why this lives in tests/ but patches node_modules: stock Pi resolves EVERY
// project-scoped path as `<cwd>/.pi/...` from a build-time constant. There is no env
// var and no settings key for it — PI_CODING_AGENT_DIR moves only the USER dir, which
// is why ~/.privateer/agent works while every project still had to spell its config
// `.pi/`. So the behaviour is a patch (patches/@earendil-works+pi-coding-agent+*.patch),
// and these tests are what keep it honest across Pi upgrades: when the patch stops
// applying or upstream moves the seams, this file fails instead of the feature quietly
// reverting to `.pi`-only.
//
// UNLIKE the rest of the patch set (UX fixes that degrade to stock Pi), this one is
// load-bearing: an unapplied patch means a project's `.privateer/settings.json` is
// silently ignored. bin/privateer-launch.mjs warns when it sees that combination.

const PI = "@earendil-works/pi-coding-agent";
const DIST = path.join(process.cwd(), "node_modules", PI, "dist");

/** Build a throwaway project tree and return its root. */
function scratch(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pv-projdir-${name}-`));
  return fs.realpathSync(dir); // macOS /var -> /private/var, so comparisons hold
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeSkill(dir: string, name: string, body: string) {
  const file = path.join(dir, "skills", name, "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`);
}

/** A user/global agent dir, so the project layering has something to sit on. */
function agentDir(root: string): string {
  const dir = path.join(root, "agent");
  writeJson(path.join(dir, "settings.json"), { model: "global-model", maxSteps: 10 });
  return dir;
}

const config = await import(path.join(DIST, "config.js"));
const { SettingsManager } = await import(path.join(DIST, "core", "settings-manager.js"));
const { hasTrustRequiringProjectResources } = await import(path.join(DIST, "core", "trust-manager.js"));
const { loadSkills } = await import(path.join(DIST, "core", "skills.js"));
const { discoverAndLoadExtensions } = await import(path.join(DIST, "core", "extensions", "loader.js"));

test("the patch is applied at all", () => {
  assert.equal(
    typeof config.projectConfigDirs,
    "function",
    "pi-coding-agent is unpatched — run the launcher once, or `node bin/apply-patches.mjs`",
  );
  // Precedence order is the whole contract: `.privateer` first, `.pi` still supported.
  assert.deepEqual(config.PROJECT_CONFIG_DIR_NAMES, [".privateer", ".pi"]);
});

test("project settings are the merge of both dirs, .privateer winning", () => {
  const root = scratch("merge");
  const agent = agentDir(root);
  const proj = path.join(root, "proj");
  writeJson(path.join(proj, ".pi", "settings.json"), {
    model: "pi-model",
    maxSteps: 42,
    packages: ["npm:from-pi"],
    providers: { ollama: { baseURL: "http://pi" }, openrouter: {} },
  });
  writeJson(path.join(proj, ".privateer", "settings.json"), {
    model: "privateer-model",
    providers: { ollama: { baseURL: "http://privateer" } },
  });

  const settings = SettingsManager.create(proj, agent).getProjectSettings();
  assert.equal(settings.model, "privateer-model", "conflicting key: .privateer wins");
  assert.equal(settings.maxSteps, 42, "non-conflicting .pi key still applies");
  assert.deepEqual(settings.packages, ["npm:from-pi"], "packages inherited from .pi");
  assert.deepEqual(
    settings.providers,
    { ollama: { baseURL: "http://privateer" }, openrouter: {} },
    "nested objects deep-merge rather than replace",
  );
});

test("either dir alone behaves exactly like stock Pi's single dir", () => {
  const root = scratch("single");
  const agent = agentDir(root);

  const piOnly = path.join(root, "pi-only");
  writeJson(path.join(piOnly, ".pi", "settings.json"), { model: "pi-model" });
  assert.equal(SettingsManager.create(piOnly, agent).getProjectSettings().model, "pi-model");

  const privOnly = path.join(root, "privateer-only");
  writeJson(path.join(privOnly, ".privateer", "settings.json"), { model: "privateer-model" });
  assert.equal(SettingsManager.create(privOnly, agent).getProjectSettings().model, "privateer-model");

  const neither = path.join(root, "neither");
  fs.mkdirSync(neither, { recursive: true });
  assert.deepEqual(SettingsManager.create(neither, agent).getProjectSettings(), {});
  assert.equal(SettingsManager.create(neither, agent).settings.model, "global-model");
});

test("writes land in .privateer and never rewrite .pi", async () => {
  const root = scratch("write");
  const agent = agentDir(root);
  const proj = path.join(root, "proj");
  const piFile = path.join(proj, ".pi", "settings.json");
  const original = { model: "pi-model", maxSteps: 42, packages: ["npm:from-pi"] };
  writeJson(piFile, original);

  const manager = SettingsManager.create(proj, agent);
  manager.setProjectPackages(["npm:from-pi", "npm:added"]);
  await manager.flush();

  assert.deepEqual(JSON.parse(fs.readFileSync(piFile, "utf8")), original, ".pi is read-only to us");
  // Only the key that actually changed is persisted — `.privateer` holds overrides,
  // not a snapshot of `.pi` that would silently diverge from it later.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(proj, ".privateer", "settings.json"), "utf8")), {
    packages: ["npm:from-pi", "npm:added"],
  });
  assert.deepEqual(SettingsManager.create(proj, agent).getProjectSettings(), {
    model: "pi-model",
    maxSteps: 42,
    packages: ["npm:from-pi", "npm:added"],
  });
});

test("either dir triggers the project trust prompt", () => {
  const root = scratch("trust");
  for (const name of [".privateer", ".pi"]) {
    const proj = path.join(root, `has-${name}`);
    fs.mkdirSync(path.join(proj, name, "extensions"), { recursive: true });
    assert.equal(hasTrustRequiringProjectResources(proj), true, `${name}/extensions must be gated`);
  }
  const bare = path.join(root, "bare");
  fs.mkdirSync(bare, { recursive: true });
  assert.equal(hasTrustRequiringProjectResources(bare), false);
});

test("skills union across both dirs, .privateer winning the name", () => {
  const root = scratch("skills");
  const agent = agentDir(root);
  const proj = path.join(root, "proj");
  writeSkill(path.join(proj, ".pi"), "shared", "from-pi");
  writeSkill(path.join(proj, ".pi"), "only-pi", "pi-exclusive");
  writeSkill(path.join(proj, ".privateer"), "shared", "from-privateer");

  const { skills } = loadSkills({ cwd: proj, agentDir: agent, skillPaths: [], includeDefaults: true });
  type LoadedSkill = { name: string; filePath: string };
  const byName = new Map<string, LoadedSkill>(
    (skills as LoadedSkill[]).map((s) => [s.name, s]),
  );
  assert.deepEqual([...byName.keys()].sort(), ["only-pi", "shared"]);
  assert.match(byName.get("shared")!.filePath, /[\\/]\.privateer[\\/]/);
});

test("a same-named project extension loads once, from .privateer", async () => {
  const root = scratch("ext");
  const agent = agentDir(root);
  const proj = path.join(root, "proj");
  const probe = path.join(root, "probe.log");
  const ext = (dir: string, file: string, tag: string) => {
    const target = path.join(proj, dir, "extensions", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Extensions are files, so without basename shadowing the lower-precedence copy
    // would load as a SECOND instance of the same extension.
    fs.writeFileSync(
      target,
      `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(probe)}, ${JSON.stringify(`${tag}\n`)});\n` +
        `export default { name: ${JSON.stringify(tag)}, version: "1.0.0" };\n`,
    );
  };
  ext(".privateer", "probe.ts", "privateer-probe");
  ext(".pi", "probe.ts", "pi-probe");
  ext(".pi", "pi-only.ts", "pi-only");

  await discoverAndLoadExtensions([], proj, agent);
  const loaded = fs.readFileSync(probe, "utf8").trim().split("\n").sort();
  assert.deepEqual(loaded, ["pi-only", "privateer-probe"], ".pi/probe.ts must be shadowed");
});

test("a .pi-relative path still resolves once .privateer exists", async () => {
  const { DefaultPackageManager } = await import(path.join(DIST, "index.js"));
  const root = scratch("relative");
  const agent = agentDir(root);
  const proj = path.join(root, "proj");
  // Relative entries are relative to the settings file that declared them. The merged
  // project scope has a single base (`.privateer`), so without a fallback this package
  // would resolve to a non-existent `.privateer/rel-pkg` and vanish from the listing.
  const pkg = path.join(proj, ".pi", "rel-pkg");
  writeJson(path.join(pkg, "package.json"), { name: "rel-pkg", version: "1.0.0", pi: { extensions: ["./index.ts"] } });
  fs.writeFileSync(path.join(pkg, "index.ts"), "export default { name: 'rel-pkg', version: '1.0.0' };\n");
  writeJson(path.join(proj, ".pi", "settings.json"), { packages: ["./rel-pkg"] });
  writeJson(path.join(proj, ".privateer", "settings.json"), { maxSteps: 9 });

  const manager = new DefaultPackageManager({
    cwd: proj,
    agentDir: agent,
    settingsManager: SettingsManager.create(proj, agent),
  });
  const configured = manager.listConfiguredPackages();
  assert.equal(configured.length, 1);
  assert.equal(configured[0].installedPath, pkg);
});
