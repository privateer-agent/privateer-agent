// The workflow runner now lives in the standalone `privateer-workflow` package (its
// canonical home). This module re-exports it so the harbor's existing
// `../workflows/runner.ts` import paths keep working unchanged.
//
// The harbor wires the runner's injected RunnerDeps to its own capabilities (headless
// runSession, relay approvals, gated child processes, the cloud outbox) in harbor/index.ts
// — that seam is unchanged; only the engine's source moved out to the shared package.
export * from "privateer-workflow/runner";
