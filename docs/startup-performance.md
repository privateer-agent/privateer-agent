# Terminal startup

Three optimizations keep the full extension set without delaying its safety hooks.

## Compile the launch into a few files

Almost all of a launch from source was per-file cost: about 3,700 modules loaded, 560
TypeScript files transpiled by Jiti, and 18,000 stat calls. `scripts/build-boot.mjs`
compiles Pi and the moat extensions into `dist-boot/`, about 190 files. Release bundles
and the npm package ship it; the launcher picks it through `bin/boot-bundle.mjs`.

A launch uses the build only when it is certainly the same code as the source beside
it. Otherwise it runs from source, which is slower and always correct:

- `PRIVATEER_NO_BOOT_BUNDLE=1` always runs from source.
- A git checkout runs from source so edits take effect. `PRIVATEER_BOOT_BUNDLE=1`
  opts in; rebuild with `npm run build:boot` first.
- The build's version must match `package.json`.
- A hoisted install (`npx`) runs from source, because the build maps files back to
  their place under `<package>/node_modules`.

The build changes packaging and nothing else. These are the properties to keep:

- **Each file keeps its identity.** `import.meta.url`, `__dirname` and `process.argv[1]`
  report the original path, so assets, workers and "where is Pi installed?" lookups
  behave as from source.
- **Each extension keeps its own copy of first-party modules**, as under Jiti. Modules
  in `src/` and the tool packs hold real state, including once-guards around global
  `fetch` and spend grants, so sharing one copy would change what those guards do.
- **Extensions get the same host modules** Pi's loader gives them: one Pi, one Typebox.
- **Only the first load comes from the build.** `/reload` and user or project extensions
  still go through Jiti.

The build fails rather than ship something subtly different: on a Pi loader or tool pack
that no longer matches what it rewrites, on patches that didn't apply, and on any dynamic
import with a computed specifier in extension code. That last one matters because such
an import stays a runtime import of a `.ts` file, Node refuses it inside `node_modules`,
and an optional-pack `catch` turns the refusal into a feature that isn't there. Use a
string literal. `tests/bootBundle.test.ts` runs the real launcher both ways and compares
the tools offered, what the permission gate blocks, and session sealing.

## Reuse the host libraries

The shipped Pi loader patch passes its already-loaded Pi and Typebox namespaces to
Jiti in ordinary Node installs, just as Pi does for its bundled runtime. This avoids
loading a second copy through an extension's import graph. Dist aliases remain as a
fallback. Extension module caching remains disabled, and `/reload` still invalidates
the factory cache and picks up edits to extensions and their local dependencies.

## Cache compiled code across launches

The terminal launcher enables Node's compiled-code cache before starting Pi. Repeated
launches can reuse bytecode for Pi and its JavaScript dependencies instead of compiling
the same code again. The first launch populates the cache; Node normally saves it when
the process exits, so close that first session normally before comparing launches.

- Default location: `~/.privateer/cache/node-compile/`, or
  `$PRIVATEER_HOME/cache/node-compile/` when using a separate Privateer home.
- `NODE_COMPILE_CACHE` overrides the location. `NODE_DISABLE_COMPILE_CACHE=1` opts out
  (also useful for coverage runs).
- An unwritable cache does not prevent startup. No cache is written in the project or
  package install directory by default.
- Node validates cached code against its runtime and source. This does not cache
  evaluated extension modules or change `/reload`, permissions, provider registration,
  or attestation checks. It does not skip any extensions.
- To clear it, close running sessions and remove that cache directory. Node regenerates
  it on subsequent launches.

For profiling, Pi's `PI_TIMING=1` prints startup phase timings. Those timings start
inside Pi and exclude the initial module graph import, so measure shell-to-ready time
as well. Test with the same settings, working directory, extensions, and machine load;
compare warm launches both with and without the cache. Avoid using forced termination
to warm the cache: a killed process may never write it.

## Quitting must not slow the next launch

Pi calls `process.exit` as soon as `session_shutdown` handlers return. Anything still
writing `auth.json` at that moment leaves its lock directory behind, and every launch
in the next 30 seconds then waits for the lock to go stale before it can paint. An
exit-path write to the credential store has to be awaited, with a time bound, as
`dropPersistedAccountCredentialBeforeExit` does.
