// The declarative workflow schema now lives in the standalone `privateer-workflow` package
// (its canonical home). This module re-exports it so the daemon's existing
// `../workflows/schema.ts` import paths (schema.ts is also the store's dependency) keep
// working unchanged.
export * from "privateer-workflow/schema";
