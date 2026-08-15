// The moat's extension inventory, read from moatManifest.json — one list, four consumers.
//
// WHY A MANIFEST. Shipping an extension used to mean four edits in three files that
// nothing connects: bin/privateer-launch.mjs's MANAGED array (removes the stale shim),
// its shim() call (installs the new one), extensionsControl's RESERVED set (stops the
// app managing it as a user package), and the profile's extensionFactories list. Miss
// one and the failure is silent in a different way each time — a lingering shim pointing
// at a deleted file, an extension that never loads, or a moat package the app offers to
// uninstall. The launcher-vs-MANAGED pair had a test (tests/extensionLoad.test.ts) purely
// to catch the omission; the RESERVED half had none, and had already drifted —
// privateer-models and privateer-connect were shimmed but never reserved. Deriving all
// four from one file makes the drift unrepresentable rather than tested-for.
//
// WHY JSON. bin/privateer-launch.mjs reads this too, and it runs BEFORE the pi patches
// are applied, with no bundler and no dependencies — it can parse JSON and nothing else.
// A .ts manifest would need the launcher to load tsx, which is exactly the ordering the
// launcher exists to avoid.
//
// IMPORT-SAFETY: no Pi imports, no side effects — safe to load from anywhere, including
// pre-boot and from a jiti-loaded extension (the readFileSync + import.meta.url pattern
// is the one extensions/privateer-brand.ts already proves under Pi's loader).

import { readFileSync } from "node:fs";

/**
 * One shipped extension. `entry` is a repo-relative path to a first-party extension;
 * `dep` is a node_modules specifier as [packageName, ...pathSegments], resolved through
 * the node_modules chain at launch (npm hoists, so a fixed path would miss). Exactly one
 * of the two is set.
 *
 * `note` is USER-VISIBLE: relayClient.sendExtensions ships it to the app, which lists it
 * under each built-in in the Extensions manager. Write it as a one-line description of
 * what the extension gives the user (English only — the app renders it verbatim, as it
 * already does for the agent's status messages), not as a code comment.
 */
export interface MoatShim {
  name: string;
  entry?: string;
  dep?: string[];
  note?: string;
}

interface Manifest {
  shims: MoatShim[];
  // Names we no longer install but still SWEEP from the agent dir on every launch, so a
  // shim written by an older version can't linger and load a package we've since dropped.
  retired: string[];
  // Extra npm names the app must not manage: the scoped published names of packages we
  // shim under a bare alias. A user hand-adding "@juicesharp/rpiv-web-tools" to settings
  // "packages" would otherwise load a second copy alongside the launcher's shim.
  reservedAliases: string[];
}

const manifest: Manifest = JSON.parse(
  readFileSync(new URL("./moatManifest.json", import.meta.url), "utf8"),
);

/** Every extension the launcher installs a shim for, in load order. */
export const MOAT_SHIMS: readonly MoatShim[] = Object.freeze(manifest.shims);

/**
 * Names the launcher clears from the agent dir's extensions/ before installing: everything
 * we ship plus everything we used to ship. The launcher reads the JSON directly (it cannot
 * import TS), so this is the TS-side mirror — tests/extensionLoad.test.ts asserts they agree.
 */
export function managedNames(): string[] {
  return [...manifest.shims.map((s) => s.name), ...manifest.retired];
}

/**
 * Names the app's extension manager must refuse to add or remove. A superset of the
 * managed names: also the scoped npm names behind our bare aliases.
 */
export function reservedNames(): string[] {
  return [...managedNames(), ...manifest.reservedAliases];
}
