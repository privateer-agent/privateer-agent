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
  const { makeAccountProvider, fetchAccountModels } = await import("../src/providers/account.ts");
  const priv = await import("../src/auth/privateer.ts");
  const { agentDir } = await import("../src/config/paths.ts");

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

  const creds = await priv.spawnAccountCredentials();
  (services.authStorage as any).set("privateer", { type: "oauth", ...creds });
  console.log(`  seeded account credential (expires in ${Math.round((creds.expires - Date.now()) / 1000)}s)`);

  const modelId = (await fetchAccountModels())[0];
  console.log(`  model: privateer/${modelId}`);
  const model = (services.modelRegistry as any).find("privateer", modelId);
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
  process.exit(gotText && gotFinish && !err ? 0 : 1);
}

main().catch((e) => {
  console.error("\nACCOUNT SMOKE ERROR:", e?.stack || e);
  process.exit(2);
});
