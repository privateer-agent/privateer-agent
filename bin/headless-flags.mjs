// The launcher's argv rules for HEADLESS runs and for Pi's own subcommands.
//
// Plain .mjs, like update-route.mjs, because bin/ runs under a bare `node` before any
// transpiler exists — and separate from the launcher because the launcher runs on
// import, so nothing inside it can be tested. See tests/headlessFlags.test.ts.

/** Every tool that bills the account — mirrors BILLED_MEDIA_TOOLS in src/permissions/classify.ts. */
export const BILLED_TOOLS = [
  "generate_image",
  "generate_video",
  "generate_model",
  "generate_sprite",
  "generate_speech",
  "generate_music",
  "generate_sfx",
];

/** The env var carrying a `--allow-spend` grant from the launcher to the gate. */
export const CLI_SPEND_ENV = "PRIVATEER_CLI_SPEND";
/** The env var carrying `--approve-in-app` (its value is the timeout in ms). */
export const APPROVE_IN_APP_ENV = "PRIVATEER_APPROVE_IN_APP";

const DEFAULT_APPROVAL_TIMEOUT_SEC = 300;

/** True when these args ask Pi for a one-shot, no-screen run. */
export function isHeadlessRun(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a === "-p" || a === "--print") return true;
    if (a === "--mode" && args[i + 1] === "json") return true;
    if (a === "--mode=json") return true;
  }
  return false;
}

function toolName(raw) {
  const t = raw.trim();
  if (!t) return null;
  // `video` is accepted for `generate_video`: it is what a person types, and it is
  // unambiguous. Anything else must be one of the billed tools, spelled out.
  const full = t.startsWith("generate_") ? t : `generate_${t}`;
  return BILLED_TOOLS.includes(full) ? full : null;
}

/**
 * Pull the headless-run flags out of `args` (in place) and validate them together.
 *
 *   --allow-spend <tool[,tool…]>   pre-approve these billed tools for THIS run
 *   --max-calls <n>                …at most n billed calls in total
 *   --max-spend <usd>              …at most this much, estimated before each call
 *   --approve-in-app               send approvals this run can't answer to the app
 *   --approval-timeout <seconds>   how long to wait for the app (default 300)
 *
 * Returns `{ spend, approveInAppMs, error }`. `error` is a message for the user and
 * means nothing else should be trusted. A spend grant must be capped (calls, dollars
 * or both) and only exists for `-p` / `--mode json` runs — in the TUI a person
 * approves each call, so there is nothing to pre-approve.
 */
export function extractHeadlessFlags(args) {
  const tools = [];
  let maxCalls;
  let maxSpendUsd;
  let approveInApp = false;
  let timeoutSec;
  let spendFlagSeen = false;

  const take = (i, name) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `${name} needs a value` };
    return { value: v };
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (!["--allow-spend", "--max-calls", "--max-spend", "--approve-in-app", "--approval-timeout"].includes(flag)) continue;

    let value = inline;
    let consumed = 1;
    if (flag !== "--approve-in-app" && value === undefined) {
      const t = take(i, flag);
      if (t.error) return { error: t.error };
      value = t.value;
      consumed = 2;
    }
    args.splice(i, consumed);
    i--;

    if (flag === "--allow-spend") {
      spendFlagSeen = true;
      for (const raw of value.split(",")) {
        const name = toolName(raw);
        if (!name) {
          return { error: `--allow-spend: "${raw.trim()}" is not a billed tool. Use one of: ${BILLED_TOOLS.join(", ")}` };
        }
        if (!tools.includes(name)) tools.push(name);
      }
    } else if (flag === "--max-calls") {
      spendFlagSeen = true;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return { error: `--max-calls must be a whole number of calls, 1 or more (got "${value}")` };
      maxCalls = n;
    } else if (flag === "--max-spend") {
      spendFlagSeen = true;
      const n = Number(String(value).replace(/^\$/, ""));
      if (!Number.isFinite(n) || n <= 0) return { error: `--max-spend must be a dollar amount above 0, e.g. 1.00 (got "${value}")` };
      maxSpendUsd = n;
    } else if (flag === "--approve-in-app") {
      approveInApp = true;
    } else if (flag === "--approval-timeout") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 10 || n > 3600) return { error: `--approval-timeout must be 10-3600 seconds (got "${value}")` };
      timeoutSec = n;
    }
  }

  const headless = isHeadlessRun(args);
  if (spendFlagSeen) {
    if (tools.length === 0) return { error: "--max-calls / --max-spend cap a spend grant — name the tools with --allow-spend <tool>" };
    if (maxCalls === undefined && maxSpendUsd === undefined) {
      return { error: "--allow-spend needs a cap: add --max-calls <n>, --max-spend <usd>, or both" };
    }
    if (!headless) {
      return { error: "--allow-spend only applies to a headless run (-p / --print, or --mode json). In the terminal UI you approve each call yourself." };
    }
  }
  if (timeoutSec !== undefined && !approveInApp) return { error: "--approval-timeout only applies with --approve-in-app" };
  if (approveInApp && !headless) {
    return { error: "--approve-in-app only applies to a headless run (-p / --print, or --mode json). An interactive terminal can use /remote-access." };
  }

  return {
    spend: tools.length ? { tools, ...(maxCalls !== undefined ? { maxCalls } : {}), ...(maxSpendUsd !== undefined ? { maxSpendUsd } : {}) } : undefined,
    approveInAppMs: approveInApp ? Math.round((timeoutSec ?? DEFAULT_APPROVAL_TIMEOUT_SEC) * 1000) : undefined,
  };
}

// Pi's own subcommands. Pi recognizes each only as args[0], so the launcher must hand
// them over with NOTHING in front — the normal launch prepends --model, -e and --skill,
// which is exactly how `privateer auth check` used to become a chat message.
export const PI_SUBCOMMANDS = ["auth", "install", "remove", "uninstall", "list", "config"];

const AUTH_SUBCOMMANDS = ["check", "print-api-key", "print-bearer-token"];

/**
 * Is `args` an `auth` invocation Pi won't understand? Returns the message to print, or
 * null. `status` is ours (answered by the launcher), `help`/--help are Pi's.
 */
export function authProblem(args, cmd = "privateer") {
  if (args[0] !== "auth") return null;
  const sub = args[1];
  if (sub === undefined || sub === "help" || sub === "status" || args.includes("--help") || args.includes("-h")) return null;
  if (AUTH_SUBCOMMANDS.includes(sub)) return null;
  return [
    `${cmd} auth: unknown command "${sub}".`,
    "",
    `  ${cmd} auth status                               is this machine signed in to Privateer?`,
    `  ${cmd} auth check --provider <name>              are a provider's credentials ready?`,
    `  ${cmd} auth print-api-key --provider <name>      print a provider's API key`,
    `  ${cmd} auth print-bearer-token --provider <name> print a provider's bearer token`,
    "",
    `Nothing was sent to a model. To sign in, run \`${cmd}\` and type /login.`,
  ].join("\n");
}
