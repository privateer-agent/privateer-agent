import { basename } from "node:path";

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
