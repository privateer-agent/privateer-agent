// The confined workflow expression/template engine now lives in the standalone
// `pi-workflow` package (its canonical home). This module re-exports it so the daemon's
// existing `../workflows/expr.ts` import paths keep working unchanged.
export * from "pi-workflow/expr";
