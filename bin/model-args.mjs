// Which `--model` the launcher hands Pi, if any.
//
// Plain .mjs for the same reason as headless-flags.mjs: bin/ runs under a bare `node`,
// and the launcher runs on import, so the rule lives where a test can reach it.
// See tests/modelArgs.test.ts.
//
// Precedence:
//   1. a --model the user typed (already in the args) → add nothing
//   2. PRIVATEER_MODEL → the computed model
//   3. a saved pick in settings.json → usually add nothing and let Pi resolve it, which
//      falls back sanely when a BYO model has vanished from the registry. EXCEPT a
//      `privateer/*` pick on a signed-in machine, which is passed explicitly (below).
//   4. nothing saved → the computed model
//
// Why the exception. Pi resolves a saved default only when that provider HAS AUTH at
// the moment the session starts (model-resolver.js findInitialModel, step 3), and if not
// it silently takes the first model that does: with an OPENROUTER_API_KEY around, that
// is Pi's openrouter default, moonshotai/kimi-k2.6. The account provider's auth is the
// one `privateer` entry in auth.json, which is machine-global and removed whenever ANY
// Privateer process exits (it revokes its own account session on the way out). So a
// launch that happened to follow another process's exit came up on OpenRouter with no
// message at all, while settings.json still said privateer/near/…. A `-p` run then sent
// its work to a ZDR provider instead of the enclave the user picked; under --private it
// refused every tool and said the model was "zdr-policy", which is how this was found.
//
// An explicit --model resolves against every REGISTERED model, auth or not
// (resolveCliModel → getModels()), and the account credential is armed at
// session_start, before the first prompt. Being signed in is the condition because
// that is when arming will succeed; signed out, the saved pick couldn't run anyway and
// Pi's own resolution is no worse.

/**
 * @param {{ launchArgs: string[], envModel?: string, savedDefault?: string | null, signedIn: boolean, computed: string }} o
 * @returns {string[]} args to prepend: [] or ["--model", spec]
 */
export function modelArgs({ launchArgs, envModel, savedDefault, signedIn, computed }) {
  if (launchArgs.includes("--model")) return [];
  if (envModel) return ["--model", computed];
  if (savedDefault) {
    return signedIn && savedDefault.startsWith("privateer/") ? ["--model", savedDefault] : [];
  }
  return ["--model", computed];
}
