import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter } from "../src/util/limit.ts";

test("createLimiter caps concurrency while running every task", async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  const done: number[] = [];
  const make = (n: number) =>
    limit(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      done.push(n);
      return n;
    });

  const out = await Promise.all([1, 2, 3, 4, 5].map(make));
  assert.equal(peak, 2, "never more than 2 at once");
  assert.deepEqual(out, [1, 2, 3, 4, 5], "all results returned in order");
  assert.equal(done.length, 5);
});

test("createLimiter with max 1 serializes tasks", async () => {
  const limit = createLimiter(1);
  let active = 0;
  let peak = 0;
  await Promise.all(
    [0, 0, 0].map(() =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      }),
    ),
  );
  assert.equal(peak, 1);
});
