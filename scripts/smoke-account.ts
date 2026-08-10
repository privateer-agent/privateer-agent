// Live proof of the Privateer ACCOUNT channel: inference billed to the subscription
// via the OAuth-registered `privateer` provider (rotating child-session JWT, no BYO
// key). Headless so the result is deterministic (no readline race).
//
// Run: node --env-file=.env --import tsx scripts/smoke-account.ts

import "../src/boot.ts";
import { mkdirSync } from "node:fs";

async function main() {
  const { createAgentSessionServices, createAgentSessionFromServices, SessionManager } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const { createEngineEventAdapter } = await import("../src/bridge/engineAdapter.ts");
  const { makeAccountProvider, fetchAccountModels, rememberAccountCredential, persistAccountCredential, dropPersistedAccountCredential } =
    await import("../src/providers/account.ts");
  const { modelRegistryOf } = await import("../src/providers/piAuthStore.ts");
  const priv = await import("../src/auth/privateer.ts");
  const { agentDir } = await import("../src/config/paths.ts");
  const { ACCOUNT_DEFAULT_MODEL_ID } = await import("../src/providers/defaultModel.ts");

  if (!priv.hasCredentials()) {
    console.log("Not signed in — run /login in the CLI first.");
    process.exit(1);
  }

  const cwd = "/private/tmp/claude-501/pv-account-work";
  mkdirSync(cwd, { recursive: true });

  const services = await createAgentSessionServices({
    cwd,
    agentDir: agentDir(),
    resourceLoaderOptions: { extensionFactories: [makeAccountProvider()] as any },
  });
  for (const d of services.diagnostics) if (d.type === "error") console.log("  ! " + d.message);

  // acquire, not spawn: reclaim the row a previously killed run left behind instead of
  // stacking another one (and a step closer to 429 CHILD_SESSION_CAP).
  const creds = await priv.acquireAccountCredential();
  await persistAccountCredential(creds);
  rememberAccountCredential(creds); // claim it, so the cleanup below drops OUR entry only
  console.log(`  seeded account credential (expires in ${Math.round((creds.expires - Date.now()) / 1000)}s)`);

  // Drive the DEFAULT account model, not `catalog[0]`.
  //
  // catalog[0] used to be picked here and the run died on "model not found in registry":
  // the provider registers its seed models synchronously and re-registers the live
  // catalog when the fetch resolves, but a POST-load registerProvider only reaches the
  // registry when the session BINDS (pi queues it — extensions/loader.js
  // pendingProviderRegistrations, flushed by bindCore). We have to resolve a model
  // *before* createAgentSessionFromServices, so at this point only the seed list exists
  // — and catalog[0] is whatever the server happens to list first. The default model is
  // in the seed list by construction, and is what a real launch actually runs.
  const catalog = await fetchAccountModels();
  const modelId = ACCOUNT_DEFAULT_MODEL_ID;
  console.log(`  live catalog: ${catalog.length} models · driving privateer/${modelId}`);
  const model = (modelRegistryOf(services) as any).find("privateer", modelId);
  if (!model) {
    console.log("  model not found in registry");
    process.exit(1);
  }
  console.log(`  resolved @ ${model.baseUrl}`);

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model,
  } as any);

  const adapter = createEngineEventAdapter();
  const events: any[] = [];
  session.subscribe((ev: any) => {
    for (const ee of adapter.toEngineEvents(ev)) {
      events.push(ee);
      if (ee.type === "text") process.stdout.write(ee.text);
    }
  });

  console.log("\n  driving a turn on the account channel…\n");
  await session.prompt("Reply with exactly the single word: ok");

  const gotText = events.some((e) => e.type === "text");
  const gotFinish = events.some((e) => e.type === "finish");
  const err = events.find((e) => e.type === "error");
  console.log("\n\n════════ ACCOUNT CHANNEL VERDICT ════════");
  console.log(`  inference via subscription (no BYO key) ... ${gotText && gotFinish && !err ? "PASS ✅" : "FAIL ❌"}`);
  if (err) console.log(`  error: ${err.error}`);

  // Leave no trace in the app's Linked Devices: revoke the session this run opened and
  // drop Pi's persisted copy, the same pairing every real exit path uses (see the
  // LIFECYCLE HAZARD note in src/auth/privateer.ts). Without it each smoke run left a
  // row alive for its full ~24h TTL.
  await priv.revokeLocalSessions();
  await dropPersistedAccountCredential();
  console.log("  cleaned up: session revoked, persisted credential dropped");
  process.exit(gotText && gotFinish && !err ? 0 : 1);
}

main().catch((e) => {
  console.error("\nACCOUNT SMOKE ERROR:", e?.stack || e);
  process.exit(2);
});
