// One account inference session for the whole harbor, shared by every run in flight.
//
// The account credential is a single slot per process — `_account` in auth/privateer.ts,
// one row per pid in accountSessions.ts, one `privateer` entry in auth.json — but the
// harbor runs several sessions at once: overlapping ticks, a submitted task, a workflow
// step and a live spawn can all be mid-turn together. Each used to mint its own session
// on start and revoke "the" session on finish, so the first run to finish revoked
// whichever session was minted LAST (another run's, mid-turn → 401) and its own leaked
// server-side until the TTL, with its registry row overwritten so no later launch could
// reclaim it.
//
// A lease fits what the slot can actually hold: the first run to need the account mints
// it, later runs share it, and the last one out revokes it. Pure — the mint and revoke
// are injected — so the ordering is testable without a server.

export interface AccountLeaseDeps {
  /** Mint the account session and arm it (persist + remember). Throws on failure. */
  mint: () => Promise<void>;
  /** Revoke the session and drop its persisted copy. Best-effort; must not throw. */
  revoke: () => Promise<void>;
  log?: (msg: string) => void;
}

export interface AccountLease {
  /** Take a reference. Resolves true when the account session is armed. ALWAYS pair with release(). */
  acquire(): Promise<boolean>;
  /** Drop a reference; the last one out revokes the session. */
  release(): Promise<void>;
  /** References held right now (tests, status). */
  readonly refs: number;
}

export function createAccountLease(deps: AccountLeaseDeps): AccountLease {
  let refs = 0;
  // The session the current holders share: resolves true once armed, false if the mint
  // failed. Undefined when nobody holds one.
  let current: Promise<boolean> | undefined;
  // The previous session's revoke. A mint waits on it, so a run that starts as the last
  // one ends never has its fresh credential dropped by the old one's teardown.
  let teardown: Promise<void> = Promise.resolve();

  return {
    get refs() {
      return refs;
    },
    async acquire() {
      refs++;
      if (!current) {
        current = teardown.then(deps.mint).then(
          () => true,
          (e) => {
            deps.log?.(`  account channel unavailable: ${e instanceof Error ? e.message : String(e)}`);
            return false;
          },
        );
      }
      const mine = current;
      const ok = await mine;
      // A failed mint is not cached: the next run should try again rather than inherit it.
      if (!ok && current === mine) current = undefined;
      return ok;
    },
    async release() {
      if (refs === 0) return;
      refs--;
      if (refs > 0) return;
      const held = current;
      current = undefined;
      if (!held) return;
      teardown = teardown.then(async () => {
        if (await held) await deps.revoke().catch(() => {});
      });
      await teardown;
    },
  };
}
