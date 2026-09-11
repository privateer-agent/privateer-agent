# Terminal startup

Two optimizations keep the full extension set without delaying its safety hooks.

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
