// Types for bin/headless-flags.mjs. Same reason as update-route.d.mts: the
// implementation is plain .mjs because bin/ runs under a bare `node`, but the tests
// that pin the grammar are TypeScript.

export const BILLED_TOOLS: string[];
export const CLI_SPEND_ENV: string;
export const APPROVE_IN_APP_ENV: string;
export const PI_SUBCOMMANDS: string[];

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

export function authProblem(args: string[], cmd?: string): string | null;
