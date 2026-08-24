import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { AttachmentStore } from "../src/util/attachmentStore.ts";
import { makeSaveAttachmentTool } from "../src/tools/saveAttachment.ts";
import { RemoteBridge } from "../src/remote/remoteBridge.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("AttachmentStore assigns ascending refs and persists bytes", () => {
  const store = new AttachmentStore();
  const a = store.register({ name: "photo.png", mediaType: "image/png", base64: b64("PNGDATA") });
  const bb = store.register({ name: "doc.pdf", mediaType: "application/pdf", base64: b64("PDFDATA") });
  assert.equal(a.n, 1);
  assert.equal(bb.n, 2);
  assert.deepEqual(store.refs(), [1, 2]);
  assert.equal(readFileSync(a.path, "utf8"), "PNGDATA");
  assert.equal(store.get(2)?.name, "doc.pdf");
  assert.equal(store.get(9), undefined);
  store.cleanup();
});

test("save_attachment writes a stored attachment to disk", async () => {
  const store = new AttachmentStore();
  store.register({ name: "note.txt", mediaType: "text/plain", base64: b64("hello attach") });
  const tool = makeSaveAttachmentTool(store);
  const out = "/private/tmp/claude-501/pv-att-test/saved.txt";
  rmSync("/private/tmp/claude-501/pv-att-test", { recursive: true, force: true });
  const res: any = await tool.execute("t1", { ref: 1, path: out }, undefined, undefined, { cwd: "/tmp" });
  assert.match(res.content[0].text, /Saved attachment #1/);
  assert.ok(existsSync(out));
  assert.equal(readFileSync(out, "utf8"), "hello attach");
  store.cleanup();
  rmSync("/private/tmp/claude-501/pv-att-test", { recursive: true, force: true });
});

test("save_attachment on a missing ref reports what's available", async () => {
  const store = new AttachmentStore();
  store.register({ name: "a", mediaType: "text/plain", base64: b64("x") });
  const res: any = await makeSaveAttachmentTool(store).execute("t", { ref: 5, path: "/tmp/x" }, undefined, undefined, {});
  assert.match(res.content[0].text, /No attachment #5.*#1/s);
  store.cleanup();
});

test("bridge onAttachment fires the owner's hook (→ store)", () => {
  const store = new AttachmentStore();
  const bridge = new RemoteBridge({
    onPrompt: () => {},
    onAttachment: (file) => store.register(file),
  });
  bridge.callbacks.onAttachment({ name: "app.png", mediaType: "image/png", base64: b64("Z") });
  assert.deepEqual(store.refs(), [1]);
  assert.equal(store.get(1)?.name, "app.png");
  store.cleanup();
});

// A session that owns its own relay (the harbor's live task spawns) registers the pair
// itself, since the gate extension stands down inside the daemon. If this factory ever
// stopped registering one of them, that session would silently lose file transfer in
// that direction — the tool simply wouldn't exist for the model.
test("relay file tools factory registers both directions against the given bridge", async () => {
  const { makeRelayFileTools } = await import("../src/tools/relayFileTools.ts");
  const store = new AttachmentStore();
  let sent: unknown = null;
  let saved: unknown = null;
  let charted: unknown = null;
  let filed: unknown = null;
  const bridge = {
    isConnected: () => true,
    sendFile: async (file: unknown) => { sent = file; return { ok: true }; },
    saveCargoRemote: async (req: unknown) => { saved = req; return { ok: true as const, cargoId: "c1", title: "Notes", storageType: "cloud" }; },
    chartOpRemote: async (req: unknown) => { charted = req; return { ok: true as const, op: "list" as const, charts: [] }; },
    saveToLibraryRemote: async (req: unknown) => { filed = req; return { ok: true as const, shelf: "document" as const, storageType: "cloud" as const, name: "Notes.md", bytes: 13 }; },
  };
  const registered = new Map<string, any>();
  makeRelayFileTools(bridge, store)({ registerTool: (t: any) => registered.set(t.name, t) });

  assert.deepEqual([...registered.keys()].sort(), [
    "create_chart", "edit_chart", "list_charts", "read_chart",
    "save_attachment", "save_cargo", "save_to_library", "send_file_to_client",
  ]);

  // save_cargo rides with the pair and must be bound to the SAME bridge — the whole
  // point of this factory is that a live task spawn's tools talk to its own relay.
  const cargoPath = "/private/tmp/claude-501/pv-relayfile-test.md";
  writeFileSync(cargoPath, "# Notes\n\nbody");
  const cargoRes: any = await registered.get("save_cargo").execute("t", { path: cargoPath }, undefined, undefined, {});
  assert.match(cargoRes.content[0].text, /Saved "Notes" to Cargo/);
  assert.equal((saved as any)?.kind, "md");
  rmSync(cargoPath, { force: true });

  // The chart tools ride here for the same reason and must be bound to the same bridge:
  // they need a connected app, not merely a signed-in account, so a spawn's charts have
  // to reach the app driving THAT session.
  const listRes: any = await registered.get("list_charts").execute("t", {});
  assert.match(listRes.content[0].text, /No charts yet/);
  assert.deepEqual(charted, { op: "list" });

  // save_to_library rides here for save_cargo's exact reason (a connected app, not
  // merely a signed-in account) and must be bound to the same bridge. Two things
  // worth pinning beyond the binding: the tool sends a `name` the model chose rather
  // than the path's basename, and it repeats back the storage the APP reported —
  // it never picks cloud or local itself.
  const docPath = "/private/tmp/claude-501/pv-relayfile-lib.md";
  writeFileSync(docPath, "# Notes\n\nbody");
  const libRes: any = await registered
    .get("save_to_library")
    .execute("t", { path: docPath, name: "Notes" }, undefined, undefined, {});
  assert.match(libRes.content[0].text, /Saved "Notes\.md" to the Library under Documents/);
  assert.match(libRes.content[0].text, /cloud storage/);
  // A name with no extension borrows the source file's, so the app can still tell
  // what kind of file it is — the shelf is chosen from the NAME, not the path.
  assert.equal((filed as any)?.name, "Notes.md");
  assert.equal((filed as any)?.mediaType, "text/markdown");
  rmSync(docPath, { force: true });

  // …and the send tool talks to THAT bridge, not some other session's.
  const path = "/private/tmp/claude-501/pv-relayfile-test.txt";
  writeFileSync(path, "payload");
  const res: any = await registered.get("send_file_to_client").execute("t", { path }, undefined, undefined, {});
  assert.match(res.content[0].text, /Sent pv-relayfile-test\.txt/);
  assert.equal((sent as any)?.name, "pv-relayfile-test.txt");
  rmSync(path, { force: true });
  store.cleanup();
});
