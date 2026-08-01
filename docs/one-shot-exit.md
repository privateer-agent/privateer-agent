# One-shot runs must exit

`privateer -p "…"` used to print its answer and then hang forever. Same for
`--mode json`. The fix is a hunk in
`patches/@earendil-works+pi-coding-agent+<version>.patch` against pi's `dist/main.js`.

## The bug

Pi's print mode ends like this:

```js
const exitCode = await runPrintMode(runtime, { … });
stopThemeWatcher();
restoreStdout();
if (exitCode !== 0) process.exitCode = exitCode;
return;                                    // ← and now we wait for the loop to drain
```

Returning is correct only if nothing else in the process holds libuv's loop open. One
ref'd resource anywhere — any extension, any dependency, any native addon — and the
process sits there with the work finished and the answer already on stdout. It reads to
the user as a stuck model call, which is why this went unnoticed: the output looks fine
if you wait for it, and invisible if you pipe it (`… | tail` shows nothing until EOF).

## What was measured

| Setup | Result |
|---|---|
| `-ne`, or an agent dir with no extensions | exits |
| Full moat loaded | never exits |
| Each moat extension alone (10 runs) | only `privateer-gate` hangs; the other nine exit |
| While hung: `process._getActiveHandles()` | `[]` |
| While hung: `process.getActiveResourcesInfo()` | `[]` |

Both handle APIs come back empty while the process refuses to die, so whatever the gate
retains is **native** — not reachable, findable, or closable from JS. (A guess that it
was a retained pi-tui clipboard watcher turned out to be wrong: the clipboard addon
loads in extensions that exit cleanly, and none of its functions are ever called.)

It is not only our code either. A user package on the same machine (`context-mode`)
spawns MCP stdio servers on `before_agent_start` — an independent reason a one-shot run
may never end. Extensions are arbitrary third-party code, so no amount of tidying our
own would make `-p` reliable.

## The fix

Exit explicitly once the run is over:

```js
await flushStdioAndExit(process.exitCode ?? 0);
```

Safe because the work is genuinely finished by then — `runPrintMode`'s `finally` has
already awaited `disposeRuntime()` (which runs extension `session_shutdown` handlers, so
session indexing and flushes complete) and `flushRawStdout()`. All that is left is the
exit itself.

`flushStdioAndExit` drains stdout and stderr before calling `process.exit`, because with
a pipe the last write may still be buffered and a bare `process.exit()` would truncate
it. A 2s unref'd backstop covers a stream that never drains.

Interactive and RPC modes are untouched: the TUI owns its teardown, and an RPC server is
meant to stay up.

## Guard

`tests/printModeExit.test.ts` runs the CLI against a mock model with an extension that
leaks a ref'd handle, and asserts the process exits and preserves a non-zero exit code.
It was confirmed to hang against an unpatched CLI, so it fails if the patch stops
applying — see `docs/project-config-dirs.md` for the patch-maintenance routine on a pi
version bump.
