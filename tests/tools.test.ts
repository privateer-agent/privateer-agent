import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createTools } from "../src/tools/index.ts";
import { autoApproveGate, type PermissionRequest } from "../src/permissions/gate.ts";
import { TodoStore } from "../src/tools/todoStore.ts";

function setup(extra?: Partial<Parameters<typeof createTools>[0]>) {
  const cwd = mkdtempSync(join(tmpdir(), "privateer-test-"));
  const tools: any = createTools({ cwd, gate: autoApproveGate, ...extra });
  const run = (name: string, args: any) => tools[name].execute(args, { toolCallId: "t", messages: [] });
  return { cwd, run, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("write then read round-trips content", async () => {
  const { cwd, run, cleanup } = setup();
  try {
    const w = await run("write", { path: "a.txt", content: "line1\nline2\n" });
    assert.match(w, /Created a\.txt/);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "line1\nline2\n");
    const r = await run("read", { path: "a.txt" });
    assert.match(r, /1\tline1/);
    assert.match(r, /2\tline2/);
  } finally {
    cleanup();
  }
});

test("edit replaces a unique string and rejects ambiguous matches", async () => {
  const { cwd, run, cleanup } = setup();
  try {
    writeFileSync(join(cwd, "b.txt"), "foo bar foo");
    const ambiguous = await run("edit", { path: "b.txt", old_string: "foo", new_string: "baz" });
    assert.match(ambiguous, /matches 2 places/);
    const ok = await run("edit", { path: "b.txt", old_string: "bar", new_string: "BAR" });
    assert.match(ok, /Edited b\.txt/);
    assert.equal(readFileSync(join(cwd, "b.txt"), "utf8"), "foo BAR foo");
    const all = await run("edit", { path: "b.txt", old_string: "foo", new_string: "X", replace_all: true });
    assert.match(all, /2 replacements/);
    assert.equal(readFileSync(join(cwd, "b.txt"), "utf8"), "X BAR X");
  } finally {
    cleanup();
  }
});

test("glob and grep find files and content", async () => {
  const { cwd, run, cleanup } = setup();
  try {
    writeFileSync(join(cwd, "x.ts"), "export const hello = 1;\n");
    writeFileSync(join(cwd, "y.md"), "# doc\n");
    const g = await run("glob", { pattern: "*.ts" });
    assert.match(g, /x\.ts/);
    assert.doesNotMatch(g, /y\.md/);
    const gr = await run("grep", { pattern: "hello", glob: "*.ts" });
    assert.match(gr, /x\.ts.*hello/);
  } finally {
    cleanup();
  }
});

test("bash runs a command and reports exit code", async () => {
  const { run, cleanup } = setup();
  try {
    const out = await run("bash", { command: "echo privateer-ok" });
    assert.match(out, /privateer-ok/);
    assert.match(out, /\[exit code 0\]/);
  } finally {
    cleanup();
  }
});

test("confinement blocks reads outside cwd when the gate denies them", async () => {
  const seen: PermissionRequest[] = [];
  const denyGate = {
    async request(req: PermissionRequest) {
      seen.push(req);
      return "deny" as const;
    },
  };
  const cwd = mkdtempSync(join(tmpdir(), "privateer-test-"));
  const tools: any = createTools({ cwd, gate: denyGate });
  const run = (name: string, args: any) => tools[name].execute(args, { toolCallId: "t", messages: [] });
  const outside = join(cwd, "..", `privateer-confine-${process.pid}.txt`);
  writeFileSync(outside, "secret");
  try {
    const out = await run("read", { path: `../${basename(outside)}` });
    assert.match(out, /outside the working directory/);
    assert.equal(seen.length, 1, "outside read should prompt the gate");
    assert.equal(seen[0].outside, true);
    // A read inside cwd never prompts.
    writeFileSync(join(cwd, "in.txt"), "ok");
    const inOut = await run("read", { path: "in.txt" });
    assert.match(inOut, /ok/);
    assert.equal(seen.length, 1, "in-cwd read should not prompt");
  } finally {
    rmSync(outside, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("confineToCwd:false lets the agent read outside cwd without prompting", async () => {
  const seen: PermissionRequest[] = [];
  const gate = {
    async request(req: PermissionRequest) {
      seen.push(req);
      return "allow" as const;
    },
  };
  const cwd = mkdtempSync(join(tmpdir(), "privateer-test-"));
  const tools: any = createTools({ cwd, gate, confineToCwd: false });
  const run = (name: string, args: any) => tools[name].execute(args, { toolCallId: "t", messages: [] });
  const outside = join(cwd, "..", `privateer-roam-${process.pid}.txt`);
  writeFileSync(outside, "reachable");
  try {
    const out = await run("read", { path: `../${basename(outside)}` });
    assert.match(out, /reachable/);
    assert.equal(seen.length, 0, "no prompt when confinement is off");
  } finally {
    rmSync(outside, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("write outside cwd is flagged outside; approved roots stop re-prompting", async () => {
  const seen: PermissionRequest[] = [];
  const allowedOutsideRoots: string[] = [];
  const gate = {
    async request(req: PermissionRequest) {
      seen.push(req);
      return "allow" as const;
    },
  };
  const cwd = mkdtempSync(join(tmpdir(), "privateer-test-"));
  const sibling = mkdtempSync(join(tmpdir(), "privateer-sibling-"));
  const tools: any = createTools({ cwd, gate, allowedOutsideRoots });
  const run = (name: string, args: any) => tools[name].execute(args, { toolCallId: "t", messages: [] });
  try {
    const out = await run("write", { path: join(sibling, "a.txt"), content: "hi\n" });
    assert.match(out, /Wrote|Created/);
    assert.equal(seen[0].outside, true);
    assert.equal(seen[0].path, join(sibling, "a.txt"));
    // Simulate the gate remembering the approved directory.
    allowedOutsideRoots.push(sibling);
    await run("write", { path: join(sibling, "b.txt"), content: "yo\n" });
    assert.notEqual(seen[1].outside, true, "approved root should not re-flag as outside");
  } finally {
    rmSync(sibling, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("todo tool records the list into the store", async () => {
  const todos = new TodoStore();
  const { run, cleanup } = setup({ todos });
  try {
    const out = await run("todo", {
      todos: [
        { content: "Explore code", status: "completed" },
        { content: "Write feature", status: "in_progress", activeForm: "Writing feature" },
      ],
    });
    assert.match(out, /1\/2 done/);
    assert.match(out, /In progress: Write feature/);
    assert.equal(todos.get().length, 2);
    assert.equal(todos.get()[1].status, "in_progress");
  } finally {
    cleanup();
  }
});

test("write/edit flag protected files for the gate", async () => {
  const seen: PermissionRequest[] = [];
  const recordingGate = {
    async request(req: PermissionRequest) {
      seen.push(req);
      return "allow" as const;
    },
  };
  const cwd = mkdtempSync(join(tmpdir(), "privateer-test-"));
  const tools: any = createTools({ cwd, gate: recordingGate });
  try {
    await tools.write.execute({ path: ".env", content: "SECRET=1\n" }, { toolCallId: "t", messages: [] });
    await tools.write.execute({ path: "normal.txt", content: "hi\n" }, { toolCallId: "t", messages: [] });
    assert.equal(seen[0].protected, true, ".env should be flagged protected");
    assert.notEqual(seen[1].protected, true, "normal.txt should not be flagged");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("web_fetch strips HTML to text (fetch mocked)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html><body><h1>Title</h1><p>Hello <b>world</b></p><script>ignore()</script></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
  const { run, cleanup } = setup();
  try {
    const out = await run("web_fetch", { url: "https://example.com" });
    assert.match(out, /\[200/);
    assert.match(out, /Title/);
    assert.match(out, /Hello world/);
    assert.doesNotMatch(out, /ignore\(\)/);
  } finally {
    globalThis.fetch = realFetch;
    cleanup();
  }
});

test("web_fetch rejects non-http urls", async () => {
  const { run, cleanup } = setup();
  try {
    assert.match(await run("web_fetch", { url: "file:///etc/passwd" }), /not a valid http/);
  } finally {
    cleanup();
  }
});
