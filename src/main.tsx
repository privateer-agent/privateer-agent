import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { Root } from "./components/Root.tsx";
import { NAME, VERSION, DESCRIPTION } from "./version.ts";
import { loadConfig, globalDir } from "./config/load.ts";
import { createSession } from "./session.ts";
import { loadLatest, loadSession } from "./memory/store.ts";
import { configuredProviders } from "./providers/resolve.ts";
import { describeError } from "./engine/errors.ts";
import { runDaemon } from "./daemon/index.ts";
import { revokeChildSession } from "./auth/privateer.ts";

// Set while Ink owns the screen. A stray unhandled rejection while the TUI is up
// must NOT reach stdout/stderr — Node's default printer dumps the whole error
// object (the request body included) unredacted and scrambles the render. The
// underlying error has already surfaced cleanly via the engine's `error` event,
// so here we just swallow the duplicate.
let tuiActive = false;

process.on("unhandledRejection", (reason) => {
  if (tuiActive) return;
  const d = describeError(reason);
  process.stderr.write(`\nError: ${d.message}${d.hint ? `\n${d.hint}` : ""}\n`);
  process.exitCode = 1;
});

interface CliOptions {
  print?: boolean;
  model?: string;
  cwd?: string;
  dangerouslySkipPermissions?: boolean;
  // Commander treats `--no-quarter` as a negatable boolean: `quarter` is true by
  // default and becomes false when the flag is passed.
  quarter?: boolean;
  continue?: boolean;
  resume?: string;
  onboard?: boolean;
  // Commander negatable boolean: `confine` is true by default, false with --no-confine.
  confine?: boolean;
}

const DEFAULT_MODEL = "anthropic:claude-opus-4-8";

async function main() {
  const program = new Command();

  program
    .name(NAME)
    .description(DESCRIPTION)
    .version(VERSION, "-v, --version")
    .argument("[prompt...]", "prompt to send (with -p, runs headless)")
    .option("-p, --print", "print mode: run headless and write the answer to stdout")
    .option("-m, --model <provider:model>", "model to use, e.g. openrouter:anthropic/claude-opus-4.8")
    .option("-C, --cwd <dir>", "working directory")
    .option("--no-confine", "let the agent read/edit outside the working directory without prompting")
    .option("--dangerously-skip-permissions", "auto-approve all tool actions (bypass mode)")
    .option("--no-quarter", "auto-approve all tool actions, taking no prisoners (bypass mode)")
    .option("-c, --continue", "resume the most recent session in this directory")
    .option("-r, --resume <id>", "resume a specific session by id (printed on exit)")
    .option("--onboard", "run the provider/key setup flow")
    .action(async (promptParts: string[], options: CliOptions) => {
      // Terminal-window close (SIGHUP) or a kill (SIGTERM) bypasses the normal
      // exit path below — revoke this terminal's Privateer session first so it
      // drops off the app's Linked Devices immediately instead of lingering
      // until server-side expiry. Installing a handler replaces Node's default
      // terminate-on-signal, so exit explicitly with the conventional code.
      const revokeAndExit = (code: number) => () => {
        void revokeChildSession().finally(() => process.exit(code));
      };
      process.on("SIGHUP", revokeAndExit(129));
      process.on("SIGTERM", revokeAndExit(143));
      try {
        if (options.cwd) process.chdir(options.cwd);
        const config = loadConfig();
        if (options.dangerouslySkipPermissions || options.quarter === false)
          config.permissionMode = "bypass";
        // --no-confine turns off the working-directory boundary for this run.
        if (options.confine === false) config.confineToCwd = false;
        // --resume <id> loads a specific session (the id printed on a prior exit);
        // --continue loads the most recent one.
        const resume = options.resume
          ? loadSession(process.cwd(), options.resume)
          : options.continue
            ? loadLatest(process.cwd())
            : null;
        if (options.resume && !resume) {
          process.stderr.write(`No session "${options.resume}" found in this directory.\n`);
        }
        const modelSpec = options.model ?? resume?.modelSpec ?? config.defaultModel ?? DEFAULT_MODEL;

        if (options.print) {
          await runPrint(modelSpec, promptParts.join(" ").trim(), config.confineToCwd);
          await revokeChildSession();
          return;
        }

        // First-run onboarding: no provider has credentials yet (and we're not
        // resuming). Also forceable with --onboard.
        const noProviderReady = !configuredProviders(config).some((p) => p.ready);
        const startInOnboarding = Boolean(options.onboard) || (!resume && noProviderReady);

        // Interactive TUI.
        tuiActive = true;
        const { waitUntilExit } = render(
          <Root
            config={config}
            modelSpec={modelSpec}
            cwd={process.cwd()}
            resume={resume}
            startInOnboarding={startInOnboarding}
          />,
        );
        await waitUntilExit();
        tuiActive = false;

        // This terminal is done — release its Privateer session so it leaves the
        // app's Linked Devices right away. Started before the resume hint prints
        // and awaited after, so it doesn't delay the output.
        const revoked = revokeChildSession();

        // On exit, print a hash that resumes this conversation later (à la Claude
        // Code). The latest persisted session carries the id used this run; it only
        // exists once at least one turn has been saved.
        const last = loadLatest(process.cwd());
        if (last && last.messages.length > 0) {
          process.stdout.write(`\nResume this session:  ${NAME} --resume ${last.id}\n`);
        }
        await revoked;
      } catch (err) {
        // Configuration/resolution errors are expected and user-facing — print them
        // cleanly without a stack trace.
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });

  // The scheduler daemon: a resident process that fires routines on their cron
  // schedule. Runs in the foreground by default; --detach forks a background copy.
  program
    .command("daemon")
    .description("run the scheduler that fires saved routines on their cron schedule")
    .option("--detach", "start the daemon in the background and return")
    .action((opts: { detach?: boolean }) => {
      if (opts.detach) {
        const logPath = join(globalDir(), "daemon.log");
        const out = openSync(logPath, "a");
        // Re-invoke this same runtime + script without --detach, fully detached.
        const args = process.argv.slice(1).filter((a) => a !== "--detach");
        const child = spawn(process.argv[0], args, { detached: true, stdio: ["ignore", out, out] });
        child.unref();
        process.stdout.write(`Daemon started in background (pid ${child.pid}).\nLogs: ${logPath}\n`);
        return;
      }
      runDaemon();
    });

  await program.parseAsync(process.argv);
}

// Headless one-shot: stream the answer to stdout, surfacing tool activity on stderr.
async function runPrint(modelSpec: string, prompt: string, confineToCwd: boolean) {
  if (!prompt) {
    process.stderr.write("No prompt provided.\n");
    process.exitCode = 1;
    return;
  }
  const session = createSession({ config: loadConfig(), modelSpec, cwd: process.cwd(), confineToCwd });
  for await (const ev of session.engine.send(prompt)) {
    switch (ev.type) {
      case "text":
        process.stdout.write(ev.text);
        break;
      case "tool-call":
        process.stderr.write(`\n· ${ev.name} ${JSON.stringify(ev.input)}\n`);
        break;
      case "tool-error":
        process.stderr.write(`\n! ${ev.name}: ${ev.error}\n`);
        break;
      case "routed":
        process.stderr.write(
          ev.missing && ev.missing.length > 0
            ? `\n⚠ no model configured for ${ev.missing.join("/")} input\n`
            : `\n↪ ${ev.label}${ev.reason ? ` · ${ev.reason}` : ""}\n`,
        );
        break;
      case "error":
        process.stderr.write(`\nError: ${ev.error}${ev.hint ? `\n${ev.hint}` : ""}\n`);
        process.exitCode = 1;
        break;
      case "finish":
        process.stdout.write(
          `\n\n[${modelSpec} · ${ev.usage.totalTokens} tokens · ${ev.finishReason}]\n`,
        );
        break;
    }
  }
}

main().catch((err) => {
  // Redact + summarize rather than dumping the raw error object, which may carry
  // request bodies or key material in provider-error fields.
  const d = describeError(err);
  process.stderr.write(`Error: ${d.message}${d.hint ? `\n${d.hint}` : ""}\n`);
  process.exit(1);
});
