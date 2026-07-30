// Session CONSTRUCTION is serialized across the whole process. pi-mcp-adapter decides
// which MCP tools to register directly at extension-activation time, and the only knob
// for that is the MCP_DIRECT_TOOLS env var — process-global state we set per run to
// keep each unattended session to its own connector allow-list. Serializing the
// (short) build window is what stops two concurrent builds from reading each other's
// value. Prompting is NOT serialized — only the build.
//
// Lifted out of harbor/index.ts so the channels runtime can share the SAME lock once
// it runs inside the harbor: two owners each with their own lock would serialize
// against themselves and race against each other, which is exactly the bug the lock
// exists to prevent.

let buildLock: Promise<unknown> = Promise.resolve();

export function serializeBuild<T>(fn: () => Promise<T>): Promise<T> {
  const run = buildLock.then(fn, fn);
  buildLock = run.catch(() => {});
  return run;
}
