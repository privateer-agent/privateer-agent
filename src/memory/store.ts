import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { globalDir } from "../config/load.ts";
import type { UsageTotals } from "../engine/events.ts";

// Persisted conversation for a project. Each session is stored under its own id so the
// `/resume` picker can browse history; `latest.json` mirrors the newest write so the
// `--continue` flag keeps working without enumerating the sessions directory.
export interface SessionData {
  id: string;
  updatedAt: string;
  modelSpec: string;
  messages: ModelMessage[];
  usage: UsageTotals;
}

// Lightweight summary used by the session picker, without loading every message.
export interface SessionMeta {
  id: string;
  updatedAt: string;
  modelSpec: string;
  messageCount: number;
  preview: string;
}

// A stable per-project key derived from the absolute cwd. Exported so other memory
// modules (e.g. auto-memory) can resolve the same per-project directory.
export function projectKey(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

function projectDir(cwd: string): string {
  return join(globalDir(), "projects", projectKey(cwd));
}

function sessionsDir(cwd: string): string {
  return join(projectDir(cwd), "sessions");
}

function latestPath(cwd: string): string {
  return join(projectDir(cwd), "latest.json");
}

function sessionPath(cwd: string, id: string): string {
  return join(sessionsDir(cwd), `${id}.json`);
}

// Per-session checkpoint directory (index + content-addressed blobs), kept alongside
// the session file so `/rewind` survives a restart when that session is resumed.
export function checkpointsDir(cwd: string, id: string): string {
  return join(projectDir(cwd), "checkpoints", id);
}

// A fresh, time-ordered session id minted once per run.
export function newSessionId(): string {
  return `s-${Date.now()}`;
}

// Pull a short, single-line preview from the first user message for the picker.
function previewOf(messages: ModelMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "(empty session)";
  const text =
    typeof first.content === "string"
      ? first.content
      : Array.isArray(first.content)
        ? first.content
            .map((p) => (p.type === "text" ? p.text : ""))
            .join(" ")
        : "";
  return text.replace(/\s+/g, " ").trim().slice(0, 72) || "(no text)";
}

export function saveSession(
  cwd: string,
  id: string,
  data: Omit<SessionData, "updatedAt" | "id">,
): void {
  mkdirSync(sessionsDir(cwd), { recursive: true });
  const payload: SessionData = { ...data, id, updatedAt: new Date().toISOString() };
  const json = JSON.stringify(payload);
  writeFileSync(sessionPath(cwd, id), json, "utf8");
  writeFileSync(latestPath(cwd), json, "utf8"); // back-compat for --continue
}

function readSessionFile(path: string): SessionData | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as SessionData;
    // Tolerate older files written before sessions had ids.
    if (!data.id) data.id = newSessionId();
    return data;
  } catch {
    return null;
  }
}

export function loadLatest(cwd: string): SessionData | null {
  return readSessionFile(latestPath(cwd));
}

export function loadSession(cwd: string, id: string): SessionData | null {
  return readSessionFile(sessionPath(cwd, id));
}

// Summaries of every stored session for this project, newest first.
export function listSessions(cwd: string): SessionMeta[] {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return [];
  const metas: SessionMeta[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const data = readSessionFile(join(dir, file));
    if (!data) continue;
    metas.push({
      id: data.id,
      updatedAt: data.updatedAt,
      modelSpec: data.modelSpec,
      messageCount: data.messages.length,
      preview: previewOf(data.messages),
    });
  }
  // Newest first; fall back to id when two writes share a millisecond.
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}
