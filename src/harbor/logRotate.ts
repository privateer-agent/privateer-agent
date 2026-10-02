// Keep a service's log file bounded.
//
// On macOS launchd appends the harbor's stdout/stderr to ~/.privateer/harbor.log and
// nothing ever trimmed it — one boot loop once grew it to 7 MB of the same line. The
// harbor can't rename the file out from under launchd (launchd keeps writing to the
// renamed file), so this copies it to <log>.1 and truncates it in place. launchd opened
// it O_APPEND, so its next write lands at the new end rather than leaving a hole.
// The few lines written between the copy and the truncate are lost; a log is allowed
// that. On Linux the unit logs to the journal and there is no file — a no-op.
//
// IMPORT-SAFETY: node builtins only.
import { copyFileSync, statSync, truncateSync, chmodSync } from "node:fs";

export const LOG_MAX_BYTES = Number(process.env.PRIVATEER_LOG_MAX_BYTES) || 5 * 1024 * 1024;

/** Rotate `path` when it has grown past `maxBytes`. True when it rotated. Never throws. */
export function rotateLogIfLarge(path: string, maxBytes: number = LOG_MAX_BYTES): boolean {
  try {
    if (statSync(path).size <= maxBytes) return false;
    copyFileSync(path, `${path}.1`);
    try {
      chmodSync(`${path}.1`, 0o600);
    } catch {
      /* non-POSIX */
    }
    truncateSync(path, 0);
    return true;
  } catch {
    return false; // no file (Linux, a manual foreground run), or unwritable
  }
}
