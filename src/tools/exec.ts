import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

const MAX_OUTPUT = 30_000; // chars per stream, to keep tool results bounded

// Run a command and capture output with a timeout. When `shell` is true the
// command string is interpreted by the shell (used by the bash tool); otherwise
// args are passed directly (used for ripgrep).
export function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; shell?: boolean; input?: string },
): Promise<ExecResult> {
  return new Promise((resolveP) => {
    const child = spawn(opts.shell ? cmd : cmd, opts.shell ? [] : args, {
      cwd: opts.cwd,
      shell: opts.shell ?? false,
      env: process.env,
    });

    // Feed the optional payload on stdin (used by hooks), then close it.
    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout?.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr: stderr + String(err), code: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const cap = (s: string) =>
        s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n… (output truncated)" : s;
      resolveP({ stdout: cap(stdout), stderr: cap(stderr), code, timedOut });
    });
  });
}
