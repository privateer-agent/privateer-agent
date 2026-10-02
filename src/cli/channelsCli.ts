// `privateer channels [run|install|uninstall|status]` dispatcher.
//
// ORDERING CONTRACT: `run` dynamically imports channels/run.ts, which imports
// ./boot.ts first (env pin + attestation dispatcher) and starts on import. The service
// subcommands touch no Pi code (harbor/service.ts is import-safe), so they don't pay
// the session-stack import cost.

function usage(): string {
  return [
    "Usage: privateer channels [command]",
    "",
    "  run          Run the channels in the foreground (default). Bridges every",
    "               channels.<platform> block in ~/.privateer/config.json.",
    "  install      Install it as a login service so it starts at login and stays up.",
    "               Re-run after changing channels from the app: it restarts them.",
    "  uninstall    Remove the login service.",
    "  status       Show whether the service is installed and which channels are live.",
  ].join("\n");
}

export async function runChannelsCli(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "run";
  switch (sub) {
    case "run": {
      await import("../channels/run.ts"); // starts on import, installs its own signal handlers
      return;
    }
    case "install": {
      const { installService } = await import("../harbor/service.ts");
      try {
        const info = installService("channels");
        process.stdout.write(
          `Channels installed as a login service.\n  unit: ${info.unitPath}\n  logs: ${info.logPath}\n` +
            "They start now and at every login. Manage with `privateer channels status|uninstall`.\n",
        );
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      return;
    }
    case "uninstall": {
      const { uninstallService } = await import("../harbor/service.ts");
      try {
        uninstallService("channels");
        process.stdout.write("Channels login service removed.\n");
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      return;
    }
    case "status": {
      const { channelsStatusReport } = await import("../harbor/service.ts");
      process.stdout.write((await channelsStatusReport()) + "\n");
      return;
    }
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(usage() + "\n");
      return;
    default:
      process.stderr.write(`Unknown channels command: ${sub}\n\n${usage()}\n`);
      process.exit(1);
  }
}
