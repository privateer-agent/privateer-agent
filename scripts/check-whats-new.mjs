#!/usr/bin/env node
// The release guard for the banner's What's New list (src/config/whatsNew.json).
//
// A release ships only when the list's `reviewedFor` names the version being released:
// someone looked at What's New for this release, even if the answer was "nothing new".
// Dependency-free on purpose: release.yml runs it straight after checkout, before any
// `npm ci`, so a forgotten list fails the release in seconds instead of after the builds.
//
//   node scripts/check-whats-new.mjs            checks against package.json's version
//   node scripts/check-whats-new.mjs v0.13.0    checks against a tag (release.yml)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const SEMVER = /^\d+\.\d+\.\d+$/;
const MAX_ITEMS = 4;

const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** Problems with the list for releasing `version`; empty means it can ship. */
export function whatsNewProblems(list, version) {
  const problems = [];
  if (!SEMVER.test(version)) return [`"${version}" is not a release version (expected X.Y.Z).`];
  if (list?.reviewedFor !== version) {
    problems.push(
      `What's New was last reviewed for ${list?.reviewedFor ?? "nothing"}, but this release is ${version}. ` +
        `Update src/config/whatsNew.json: add or trim entries if there's news, then set "reviewedFor": "${version}".`,
    );
  }
  const items = Array.isArray(list?.items) ? list.items : [];
  if (items.length === 0) problems.push("What's New has no entries.");
  if (items.length > MAX_ITEMS) problems.push(`What's New has ${items.length} entries; the banner fits ${MAX_ITEMS}.`);
  items.forEach((item, i) => {
    const at = `entry ${i + 1}`;
    if (typeof item?.text !== "string" || !item.text.trim()) problems.push(`${at} has no text.`);
    if (item?.cmd !== undefined && (typeof item.cmd !== "string" || !item.cmd.startsWith("/"))) {
      problems.push(`${at}: cmd should be a slash command.`);
    }
    if (typeof item?.since !== "string" || !SEMVER.test(item.since)) problems.push(`${at} needs "since": the release it arrived in.`);
    else if (cmp(item.since, version) > 0) problems.push(`${at} says it arrives in ${item.since}, after ${version}.`);
    else if (i > 0 && SEMVER.test(items[i - 1]?.since ?? "") && cmp(item.since, items[i - 1].since) > 0) {
      problems.push(`${at} is newer than the one above it; the list is newest first.`);
    }
  });
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const list = JSON.parse(readFileSync(new URL("src/config/whatsNew.json", root), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const version = (process.argv[2] ?? pkg.version).replace(/^v/, "");
  const problems = whatsNewProblems(list, version);
  if (process.argv[2] && version !== pkg.version) {
    problems.unshift(`Tag ${process.argv[2]} doesn't match package.json's version ${pkg.version}.`);
  }
  if (problems.length) {
    for (const p of problems) console.error(process.env.GITHUB_ACTIONS ? `::error::${p}` : `✗ ${p}`);
    process.exit(1);
  }
  console.log(`What's New is reviewed for ${version}.`);
}
