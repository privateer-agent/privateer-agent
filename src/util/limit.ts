// A minimal async concurrency limiter. `run(task)` resolves the task's value but
// never lets more than `max` tasks run at once; the rest queue FIFO. Used to bound
// how many `task` sub-agents execute in parallel when the model fans them out.
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];

  function release(): void {
    const next = queue.shift();
    if (next) next(); // hand the slot straight to the next waiter (active unchanged)
    else active--; // no waiter → free the slot
  }

  async function acquire(): Promise<void> {
    if (active < max) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve)); // slot handed to us
  }

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
