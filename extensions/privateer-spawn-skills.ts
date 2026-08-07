// Per-spawn skills — the skills a folder carries, without touching the folder.
//
// Pi discovers project skills at `<cwd>/.privateer/skills` (and `<cwd>/.pi/skills`),
// resolved lexically from cwd with no override — see projectConfigDirCandidates. That
// is the right home for skills a TEAM shares through the repo, and the wrong one for
// "the skills I use in this folder on this machine": giving a folder its own skills
// would mean writing into the user's tree, where it lands in their next `git status`.
//
// So per-spawn skills live under the global dir with that folder's other defaults
// (src/config/spawns.ts), and this extension hands the directory to Pi through the
// `resources_discover` hook — the supported way to contribute skill paths. Nothing is
// patched, and the skills are loaded by the session itself, so the model can actually
// invoke them rather than merely having them listed in the app's Skills manager.
//
// Note this contributes PATHS, not skills: Pi still owns discovery, precedence and
// the disable-model-invocation flag inside them.

import { existsSync } from "node:fs";
import { spawnSkillsDir } from "../src/config/spawns.ts";

export default function privateerSpawnSkills(pi: any): void {
  pi.on("resources_discover", (event: any) => {
    // `cwd` comes from the event rather than a captured value: the desktop rebuilds
    // its session on a folder switch, and a stale closure would keep feeding the old
    // folder's skills to the new one.
    const cwd = event?.cwd ?? process.cwd();
    let dir: string;
    try {
      dir = spawnSkillsDir(cwd);
    } catch {
      return; // no global dir (PRIVATEER_HOME unset in a stripped environment)
    }
    // Only offer a directory that exists. Pi tolerates a missing path, but an empty
    // contribution is also how `emitResourcesDiscover` decides there is nothing to
    // reload — so staying silent keeps a spawn with no skills of its own free.
    if (!existsSync(dir)) return;
    return { skillPaths: [dir] };
  });
}
