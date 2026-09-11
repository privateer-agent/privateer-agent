import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  clearExtensionCache,
  loadExtensionsCached,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

// Exercise the shipped JS loader, not a mock of Jiti. Shared host libraries must
// not turn into shared/cached extension state: /reload must still see edited code.
test("startup: extensions reuse host libraries but reload their own modules", async (t) => {
  // Pi can have its own nested Typebox version. Compare with the host's dependency,
  // not this project's possibly different version (the loader's old aliases do too).
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { Type } = await import(pathToFileURL(piRequire.resolve("typebox")).href);
  const root = mkdtempSync(join(tmpdir(), "privateer-startup-modules-"));
  const probe = Symbol.for(root);
  t.after(() => {
    Reflect.deleteProperty(globalThis, probe);
    clearExtensionCache();
    rmSync(root, { recursive: true, force: true });
  });
  const entry = join(root, "extension.ts");
  const dependency = join(root, "value.ts");
  writeFileSync(dependency, "export const value = 1;\n");
  const source = (prefix: string) => `
    import { Type } from "typebox";
    import { getAgentDir } from "@earendil-works/pi-coding-agent";
    import { value } from "./value.ts";
    const probe = Symbol.for(${JSON.stringify(root)});
    globalThis[probe] = { Type, getAgentDir, value };
    export default function (pi) {
      pi.registerCommand("cache-probe", {
        description: ${JSON.stringify(prefix)} + value,
        handler: async () => {},
      });
    }
  `;
  writeFileSync(entry, source("first-"));
  clearExtensionCache();
  const first = await loadExtensionsCached([entry], root);
  assert.deepEqual(first.errors, []);
  const observed = Reflect.get(globalThis, probe);
  assert.equal(observed.Type, Type, "Typebox must come from the host, not another Jiti graph");
  assert.equal(observed.getAgentDir, getAgentDir, "Pi exports must retain host identity");
  assert.equal(first.extensions[0].commands.get("cache-probe")?.description, "first-1");

  writeFileSync(dependency, "export const value = 2;\n");
  writeFileSync(entry, source("reloaded-"));
  clearExtensionCache(); // the same invalidation used by /reload
  const second = await loadExtensionsCached([entry], root);
  assert.deepEqual(second.errors, []);
  assert.equal(second.extensions[0].commands.get("cache-probe")?.description, "reloaded-2");
  assert.equal(Reflect.get(globalThis, probe).getAgentDir, getAgentDir);
});
