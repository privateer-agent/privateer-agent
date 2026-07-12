/**
 * Extension management for linked terminals.
 *
 * A UI-agnostic wrapper over Pi's PackageManager so the app (over the relay) can
 * see which Pi extensions THIS terminal has installed and add/remove them — the
 * same way the model picker lets the app switch models. Both the dev REPL
 * (src/cli/chat.ts) and the shipped TUI (extensions/privateer-gate.ts) build one
 * of these and route the extensions_* relay frames through it.
 *
 * Only the user's OWN packages surface here. The Privateer moat (privateer-*,
 * pi-privacy, rpiv-web-tools, …) is installed by bin/privateer-tui as shim .ts
 * files in the agent dir's extensions/ folder — auto-discovered, NOT recorded in
 * settings.json "packages". listConfiguredPackages() reads only "packages", so the
 * moat is naturally excluded. We keep a RESERVED name guard as defence in depth in
 * case a user ever hand-adds one of our package names.
 *
 * Framework-agnostic: nothing here imports React or the relay. The caller owns the
 * frame plumbing and hands us a SettingsManager (the REPL reuses the session's;
 * the TUI creates a fresh one — both read the same ~/.privateer/agent/settings.json).
 */
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { ProgressEvent, SettingsManager } from "@earendil-works/pi-coding-agent";

// One installed extension as surfaced to the app. NON-PII: a package source
// (npm:/git: spec) plus its scope — no cwd, no absolute paths beyond what Pi
// already resolved. `installed` reflects whether the package is downloaded on disk
// yet (a freshly-added one persists to settings before its install completes).
export interface InstalledExtension {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installed: boolean;
  installedPath?: string;
}

export interface ExtensionsControl {
  // The user's own configured packages (moat excluded). Cheap — reads settings.
  listInstalled(): InstalledExtension[];
  // Persist + download an npm:/git:/path package to USER settings. Returns ok:false
  // with Pi's own message on a bad spec or a failed npm/git fetch.
  add(source: string): Promise<{ ok: boolean; message?: string }>;
  // Remove from USER settings + prune the cache. ok:false when nothing matched.
  remove(source: string): Promise<{ ok: boolean; message?: string }>;
  // Progress callback for the current add/remove (install/clone/pull steps), so the
  // caller can relay a busy indicator. Pass undefined to clear.
  setProgress(cb: ((ev: ProgressEvent) => void) | undefined): void;
}

// Package names we never manage from the app: the Privateer moat + adopted packs
// installed as shims by the launcher. A guard only — listConfiguredPackages()
// already omits them since they aren't settings "packages".
const RESERVED = new Set([
  "privateer-brand",
  "privateer-context",
  "privateer-gate",
  "privateer-account",
  "privateer-posture",
  "privateer-tools",
  "privateer-privacy",
  "pi-privacy",
  "pi-web-access",
  "rpiv-web-tools",
  "@juicesharp/rpiv-web-tools",
  "pi-mcp-adapter",
  "pi-hypa",
  "@hypabolic/pi-hypa",
  "pi-subagents",
]);

// The bare package name inside a source spec, for the RESERVED check. Strips the
// npm:/git: scheme and any @version / #ref suffix; leaves scoped names intact.
function packageName(source: string): string {
  let s = source.trim();
  const scheme = s.indexOf(":");
  if (scheme > 0 && /^(npm|git)$/i.test(s.slice(0, scheme))) s = s.slice(scheme + 1);
  // Drop a trailing @version (but not the leading @ of a scope) and a git #ref.
  s = s.replace(/#.*$/, "");
  const at = s.lastIndexOf("@");
  if (at > 0) s = s.slice(0, at);
  return s;
}

export function makeExtensionsControl(opts: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
}): ExtensionsControl {
  const pm = new DefaultPackageManager({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    settingsManager: opts.settingsManager,
  });

  return {
    listInstalled(): InstalledExtension[] {
      let configured: Array<{ source: string; scope: string; filtered: boolean; installedPath?: string }> = [];
      try {
        configured = pm.listConfiguredPackages() as typeof configured;
      } catch {
        return [];
      }
      return configured
        .filter((p) => !RESERVED.has(packageName(p.source)))
        .map((p) => ({
          source: p.source,
          scope: p.scope === "project" ? "project" : "user",
          filtered: !!p.filtered,
          installed: !!p.installedPath,
          installedPath: p.installedPath,
        }));
    },

    async add(source: string): Promise<{ ok: boolean; message?: string }> {
      const src = source.trim();
      if (!src) return { ok: false, message: "No package specified." };
      if (RESERVED.has(packageName(src))) return { ok: false, message: "That extension is managed by Privateer." };
      try {
        await pm.installAndPersist(src, { local: false });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },

    async remove(source: string): Promise<{ ok: boolean; message?: string }> {
      const src = source.trim();
      if (!src) return { ok: false, message: "No package specified." };
      try {
        const removed = await pm.removeAndPersist(src, { local: false });
        return removed ? { ok: true } : { ok: false, message: "Not installed." };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },

    setProgress(cb: ((ev: ProgressEvent) => void) | undefined): void {
      pm.setProgressCallback(cb);
    },
  };
}
