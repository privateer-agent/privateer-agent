// `privateer daemon [run|install|uninstall|status]` dispatcher.
//
// ORDERING CONTRACT: import ./boot.ts FIRST (env pin + attestation dispatcher), then
// DYNAMICALLY import the daemon (which pulls the Pi session stack) only when we
// actually run it — so boot's side effects are guaranteed to precede any Pi import.
// The service/status subcommands touch no Pi code, so they can run without paying the
// session-stack import cost.
import "../boot.ts";

function usage(): string {
  return [
    "Usage: privateer daemon [command]",
    "",
    "  run          Run the daemon in the foreground (default).",
    "  install      Install it as a login service so it auto-starts and stays",
    "               reachable from the app even with no terminal open.",
    "  uninstall    Remove the login service.",
    "  status       Show whether the service is installed and the daemon is live.",
  ].join("\n");
}

export async function runDaemonCli(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "run";
  switch (sub) {
    case "run": {
      // Pi-touching — dynamic import AFTER boot.
      const { runDaemon } = await import("../daemon/index.ts");
      runDaemon(); // installs its own SIGINT/SIGTERM handlers and blocks
      return;
    }
    case "install": {
      const { installService } = await import("../daemon/service.ts");
      try {
        const info = installService();
        process.stdout.write(`Privateer daemon installed as a login service.\n  unit: ${info.unitPath}\n  logs: ${info.logPath}\nIt will start now and on every login. Manage with \`privateer daemon status|uninstall\`.\n`);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      return;
    }
    case "uninstall": {
      const { uninstallService } = await import("../daemon/service.ts");
      try {
        uninstallService();
        process.stdout.write("Privateer daemon login service removed.\n");
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      return;
    }
    case "status": {
      const { statusReport } = await import("../daemon/service.ts");
      process.stdout.write((await statusReport()) + "\n");
      return;
    }
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(usage() + "\n");
      return;
    default:
      process.stderr.write(`Unknown daemon command: ${sub}\n\n${usage()}\n`);
      process.exit(1);
  }
}
