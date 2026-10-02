import { basename, dirname, join, sep } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { agentDir, globalDir } from "../config/paths.ts";

// Files we never auto-edit, even under acceptEdits/allowlist: shell rc / git /
// package-manager / secrets that a coding task should not silently rewrite. A
// protected target forces an interactive prompt (it can still
// be approved), and is never covered by `acceptEdits` or a bash allowlist entry.
const PROTECTED_BASENAMES = new Set([
  ".gitconfig",
  ".git-credentials",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".profile",
  ".npmrc",
  ".netrc",
  ".env",
  ".mcp.json",
  ".privateer.json",
]);

// Also treat any dotfile holding the word "env" or "secret" as sensitive.
function looksSensitive(name: string): boolean {
  return /^\.env(\..+)?$/.test(name) || /secret|credential/i.test(name);
}

export function isProtectedPath(p: string): boolean {
  const name = basename(p);
  return PROTECTED_BASENAMES.has(name) || looksSensitive(name);
}

// Where this machine keeps credentials that are never a coding task's business: the
// standard per-user secret directories, and the files at the top of our OWN state
// dirs — credentials.json, agent/auth.json, terminal-key.json, config.json (bot
// tokens, provider keys), mcp.json, account-trust.json and the rest. Only the TOP
// level of ~/.privateer and its agent dir: their subdirectories (routines output,
// projects, sessions) are ordinary data a run may legitimately be pointed at.
//
// Consulted only by surfaces that opt in (ScopeOptions.guardSecretReads — the
// harbor's unattended runs), where a READ of one of these is refused even inside the
// working directory: an unattended run that fetches a web page is one prompt
// injection away from reading a token and putting it in the next URL it fetches.
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", join(".config", "gh"), join(".config", "gcloud")];

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function within(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function isCredentialStorePath(abs: string): boolean {
  const home = homedir();
  if (SECRET_DIRS.some((d) => within(canonical(join(home, d)), abs))) return true;
  const parent = dirname(abs);
  return parent === canonical(globalDir()) || parent === canonical(agentDir());
}
