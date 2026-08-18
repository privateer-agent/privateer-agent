// The PII allowlist the OPERATOR controls — "that string is not personal data, stop
// masking it."
//
// WHY THIS EXISTS. pi-privacy's detection is pattern-based and honest about it: it fires
// on anything email-SHAPED or address-SHAPED. It refuses the shapes that are impossible
// for a type (see its precision guards), but plenty of real-world strings are genuinely
// ambiguous — a bare `8.0.0.0` is a version quad AND a valid address, an internal
// hostname list is a list of addresses, a fixture mailbox is an address nobody reads. For
// those the only correct answer comes from the person, and until now Privateer gave them
// nowhere to put it: sharedPrivacyOptions() hand-built pi-privacy's options and never
// called its config loader, so `PI_PRIVACY_PII_ALLOW` and pi-privacy.config.json were
// silently ignored in every Privateer session. The only lever was "Send + remember for
// session", which is all-or-nothing and forgotten at exit.
//
// This matters more since the gate learned to answer itself: under no quarter the
// question is swallowed and the payload is auto-redacted, so a false positive is no
// longer a prompt you dismiss — it is a silent rewrite the model then reads.
//
// WHERE IT LIVES. `privacy.piiAllow` in ~/.privateer/config.json (the same file the
// harbor, channels and webhooks read). Entry forms are pi-privacy's — `me@acme.com`
// (exact, `*` globs), `@acme.com` (that domain and its subdomains), `10.0.0.0/8` (an
// IPv4 block), or any exact/globbed value.
//
// LIVE, NOT LATCHED. entries() is handed to pi-privacy as a function, so `/privacy allow
// …` applies on the next turn instead of the next launch. It is called once per matched
// value during a scan, so it must stay cheap: the JSON is re-parsed only when the file
// changes (stamp = mtime + size), which leaves a stat per call and nothing else. An edit
// made in an editor is picked up on the next scan, exactly like one made through the
// command — there is no "restart to apply" step to explain.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { configPath } from "./paths.ts";

let cached: string[] = [];
let cachedStamp = "";

function parse(raw: unknown): string[] {
  const list = (raw as any)?.privacy?.piiAllow;
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is string => typeof e === "string" && e.trim() !== "").map((e) => e.trim());
}

/**
 * The operator's allowlist, live. Missing file, unreadable file and malformed JSON all
 * mean "no entries" — a config typo must not take the PII gate down with it, and the
 * gate erring toward MORE detection is the safe direction.
 */
export function piiAllowEntries(): readonly string[] {
  try {
    const st = statSync(configPath());
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp === cachedStamp) return cached;
    cachedStamp = stamp;
    cached = parse(JSON.parse(readFileSync(configPath(), "utf8")));
  } catch {
    cachedStamp = "";
    cached = [];
  }
  return cached;
}

/** Drop the cache — after our own write, so the stamp is never mistaken for unchanged. */
function invalidate(): void {
  cachedStamp = "";
}

// A bare `*` allows every value of every type: that is `piiPolicy: off` wearing a
// different hat, and pi-privacy refuses it at compile time anyway. Refusing it HERE means
// the person who typed it is told, rather than watching an entry land in their config and
// do nothing.
function invalidReason(entry: string): string | undefined {
  if (!entry) return "an empty entry matches nothing";
  if (/^\*+$/.test(entry)) return "a bare `*` would allowlist everything — turn the gate off explicitly if that's what you mean";
  return undefined;
}

export interface AllowEdit {
  ok: boolean;
  /** Why it was refused, or what already stood. Always safe to show the user. */
  message: string;
  entries: readonly string[];
}

function write(entries: string[]): void {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    /* new or unreadable — a fresh object, so one bad file doesn't lose the edit */
  }
  const privacy = { ...((cfg.privacy as Record<string, unknown>) ?? {}), piiAllow: entries };
  writeFileSync(configPath(), JSON.stringify({ ...cfg, privacy }, null, 2) + "\n");
  invalidate();
}

/** Add one entry. Idempotent — adding what's already there is reported, not duplicated. */
export function addPiiAllow(raw: string): AllowEdit {
  const entry = raw.trim();
  const bad = invalidReason(entry);
  if (bad) return { ok: false, message: bad, entries: piiAllowEntries() };
  const entries = [...piiAllowEntries()];
  if (entries.includes(entry)) return { ok: true, message: `${entry} is already allowlisted`, entries };
  entries.push(entry);
  write(entries);
  return { ok: true, message: `${entry} is no longer treated as PII in this and future sessions`, entries };
}

/** Remove one entry, exactly as written. */
export function removePiiAllow(raw: string): AllowEdit {
  const entry = raw.trim();
  const entries = [...piiAllowEntries()];
  const i = entries.indexOf(entry);
  if (i < 0) return { ok: false, message: `${entry || "(empty)"} is not in the allowlist`, entries };
  entries.splice(i, 1);
  write(entries);
  return { ok: true, message: `${entry} is gated again`, entries };
}
