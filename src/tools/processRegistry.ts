import { spawn, type ChildProcess } from "node:child_process";

export interface BgProcess {
  id: string;
  command: string;
  status: "running" | "exited";
  code: number | null;
  startedAt: number;
}

const MAX_OUTPUT = 200_000; // cap retained output per process

// Tracks background shells started by the bash tool (run_in_background). Output
// accumulates as it streams; `read` returns only what's new since the last read so
// the model can poll a long-running command.
export class ProcessRegistry {
  private procs = new Map<string, { meta: BgProcess; child: ChildProcess; output: string; offset: number }>();
  private seq = 0;

  spawn(command: string, cwd: string): string {
    const id = `bash_${++this.seq}`;
    const child = spawn(command, [], { cwd, shell: true, env: process.env });
    const entry: { meta: BgProcess; child: ChildProcess; output: string; offset: number } = {
      meta: { id, command, status: "running", code: null, startedAt: Date.now() },
      child,
      output: "",
      offset: 0,
    };
    const append = (d: Buffer) => {
      if (entry.output.length < MAX_OUTPUT) entry.output += d.toString();
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (e) => {
      entry.output += `\n[error] ${e.message}`;
      entry.meta.status = "exited";
    });
    child.on("close", (code) => {
      entry.meta.status = "exited";
      entry.meta.code = code;
    });
    this.procs.set(id, entry);
    return id;
  }

  // New output since the last read, plus current status.
  read(id: string): { output: string; status: BgProcess["status"]; code: number | null } | null {
    const e = this.procs.get(id);
    if (!e) return null;
    const fresh = e.output.slice(e.offset);
    e.offset = e.output.length;
    return { output: fresh, status: e.meta.status, code: e.meta.code };
  }

  kill(id: string): boolean {
    const e = this.procs.get(id);
    if (!e) return false;
    e.child.kill("SIGTERM");
    e.meta.status = "exited";
    return true;
  }

  list(): BgProcess[] {
    return [...this.procs.values()].map((e) => e.meta);
  }

  // Best-effort teardown of all background shells (called on app exit).
  killAll(): void {
    for (const e of this.procs.values()) {
      try {
        e.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}
