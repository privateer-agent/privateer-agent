// Run a routine end-to-end through the rewired harbor: headless Pi session →
// text result → file delivery. Exercises runRoutine (the one rewired seam) plus
// the KEEP delivery path.
//
// Run: node --env-file=.env --import tsx scripts/smoke-harbor.ts

import "../src/boot.ts";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";

async function main() {
  const { Harbor } = await import("../src/harbor/index.ts");
  const { Routine } = await import("../src/routines/schema.ts");
  const { routineOutputDir } = await import("../src/routines/store.ts");

  const WORK = "/private/tmp/claude-501/pv-harbor-work";
  mkdirSync(WORK, { recursive: true });

  const routine = Routine.parse({
    id: "r-smoke",
    name: "smoke-brief",
    cron: "0 8 * * *", // never actually due in this test; we call runRoutine directly
    prompt: "Reply with exactly: harbor ok",
    cwd: WORK,
    model: "openrouter/openai/gpt-4o-mini",
    delivery: ["file"],
    enabled: true,
  });

  console.log("Running routine via the harbor (headless Pi → file delivery)…\n");
  const res = await new Harbor().runRoutine(routine);
  console.log(`  runRoutine → ok=${res.ok} delivered=${res.message}`);

  // Read the delivered file.
  const dir = routineOutputDir("smoke-brief");
  let fileText = "";
  try {
    const files = readdirSync(dir).sort();
    if (files.length) fileText = readFileSync(`${dir}/${files[files.length - 1]}`, "utf8");
  } catch {
    /* no dir */
  }

  const deliveredFile = (res.message ?? "").includes("file");
  const hasBody = /harbor ok/i.test(fileText);
  console.log(`\n  file (${dir}):\n${fileText.split("\n").map((l) => "    " + l).join("\n")}`);

  console.log("\n════════ HARBOR VERDICT ════════");
  console.log(`  routine ran + delivered to file .......... ${deliveredFile ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`  result contains the model's reply ........ ${hasBody ? "PASS ✅" : "FAIL ❌"}`);
  process.exit(deliveredFile && hasBody ? 0 : 1);
}

main().catch((e) => {
  console.error("\nHARBOR SMOKE ERROR:", e?.stack || e);
  process.exit(2);
});
