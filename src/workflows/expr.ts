// The confined workflow expression/template engine now lives in the standalone
// `privateer-workflow` package (its canonical home). This module re-exports it so the
// harbor's existing `../workflows/expr.ts` import paths keep working unchanged.
export * from "privateer-workflow/expr";
