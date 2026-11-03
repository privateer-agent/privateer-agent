// Types for session sealing (bin/session-seal.mjs). Same reason as the other
// bin/*.d.mts: bin/ runs under a bare `node`, but its tests are TypeScript.

export const CODEC_KEY: unique symbol;
export const QUIET_MS: number;

export interface SessionCodec {
  failures: number;
  encode(entry: unknown): string;
  decode(obj: unknown): any;
}

export function keyPath(home: string): string;
export function loadOrCreateKey(home: string): Buffer;
export function isSealed(obj: unknown): boolean;
export function encodeEntry(entry: unknown, key: Buffer): string;
export function decodeEntry(obj: unknown, key: Buffer): any;
export function installCodec(home: string): { ok: true } | { ok: false; error: string };
export function sealFile(file: string, key: Buffer): "sealed" | "unchanged" | "busy" | "failed";
export function listSessionFiles(sessionsDir: string): string[];
export function sweepSessions(
  home: string,
  sessionsDir: string,
  opts?: { now?: number; quietMs?: number },
): Promise<{ skipped: true } | { error: true } | { sealed: number; unchanged: number; busy: number; failed: number; recent: number }>;
