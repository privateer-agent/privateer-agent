// Types for bin/headless-flags.mjs. Same reason as update-route.d.mts: the
// implementation is plain .mjs because bin/ runs under a bare `node`, but the tests
// that pin the grammar are TypeScript.

export const BILLED_TOOLS: string[];
export const CLI_SPEND_ENV: string;
export const APPROVE_IN_APP_ENV: string;
export const PI_SUBCOMMANDS: string[];
export const PRIVATE_ENV: string;

export interface CliSpendGrant {
  tools: string[];
  maxCalls?: number;
  maxSpendUsd?: number;
}

export function isHeadlessRun(args: string[]): boolean;

/** Strips the headless flags out of `args` in place. */
export function extractHeadlessFlags(args: string[]): {
  spend?: CliSpendGrant;
  approveInAppMs?: number;
  error?: string;
};

/** Strips `--private` out of `args` in place; true when it was there. */
export function extractPrivateFlag(args: string[]): boolean;

/** Why these args can't run under --private, or null. */
export function privateProblem(args: string[]): string | null;

export function authProblem(args: string[], cmd?: string): string | null;
