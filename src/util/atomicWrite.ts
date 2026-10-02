// Replace a file all at once: write a sibling temp file, then rename it over the target.
//
// A plain writeFileSync truncates first and writes second, so a crash, a full disk or a
// kill in between leaves a short or empty file. For the files this is used on that is
// worse than losing the write: loadRoutines() reads a half-written routines.json as "no
// routines", and the next save from the app then writes just the one routine it holds —
// every other routine gone. rename() is atomic on one filesystem, so a reader sees the
// old file or the new one and never anything between.
//
// Permissions carry over from the file being replaced (a config.json someone chmod'ed
// 0600 stays 0600). A new file gets `mode`, default 0600: everything written through
// here is config that can hold tokens.
//
// IMPORT-SAFETY: node builtins only.
import { chmodSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export function writeFileAtomic(path: string, data: string, opts: { mode?: number } = {}): void {
  // Follow a symlinked config to the file it names, so we replace the file rather than
  // the link (which would quietly detach a dotfiles-managed config).
  let target = path;
  let mode = opts.mode ?? 0o600;
  try {
    target = realpathSync(path);
    if (opts.mode === undefined) mode = statSync(target).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode });
    try {
      chmodSync(tmp, mode); // writeFileSync's mode is filtered by the umask
    } catch {
      /* non-POSIX filesystem */
    }
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* never created */
    }
    throw e;
  }
}
