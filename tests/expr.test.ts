import { test } from "node:test";
import assert from "node:assert/strict";

const { evaluate, evalCondition, renderTemplate, TemplateError } = await import("../src/workflows/expr.ts");

const ctx = {
  workflow: { input: { repo: "acme/app", threshold: 8, tags: ["email", "daily"] } },
  planner: { output: { items: [1, 2, 3], score: 9, label: "ready", nested: { deep: "yes" } } },
  gate: { choice: "approve" },
  empty: { output: {} },
};

test("path resolution: nested, arrays, index, missing", () => {
  assert.equal(evaluate("workflow.input.repo", ctx), "acme/app");
  assert.equal(evaluate("planner.output.score", ctx), 9);
  assert.equal(evaluate("planner.output.items[0]", ctx), 1);
  assert.equal(evaluate("planner.output.items[1]", ctx), 2);
  assert.equal(evaluate("planner.output.nested.deep", ctx), "yes");
  assert.equal(evaluate("planner.output.items.length", ctx), 3);
  assert.equal(evaluate("workflow.input.tags.length", ctx), 2);
  assert.equal(evaluate("does.not.exist", ctx), undefined);
});

test("dynamic index via [expr]", () => {
  const c = { arr: ["a", "b", "c"], i: 2, key: "repo", m: { repo: "x" } };
  assert.equal(evaluate("arr[i]", c), "c");
  assert.equal(evaluate("m[key]", c), "x");
});

test("comparisons with numeric coercion", () => {
  assert.equal(evalCondition("planner.output.score >= workflow.input.threshold", ctx), true);
  assert.equal(evalCondition("planner.output.score > 9", ctx), false);
  assert.equal(evalCondition("planner.output.score == 9", ctx), true);
  assert.equal(evalCondition("planner.output.label == 'ready'", ctx), true);
  assert.equal(evalCondition("planner.output.label != 'ready'", ctx), false);
  // string "8" vs number 8 → loose numeric equality
  assert.equal(evaluate("'8' == 8", {}), true);
  assert.equal(evaluate("gate.choice == 'approve'", ctx), true);
});

test("logical and/or/not and grouping", () => {
  assert.equal(evalCondition("planner.output.score >= 8 and gate.choice == 'approve'", ctx), true);
  assert.equal(evalCondition("planner.output.score > 100 or gate.choice == 'approve'", ctx), true);
  assert.equal(evalCondition("not (planner.output.score > 100)", ctx), true);
  assert.equal(evalCondition("!(planner.output.score > 100)", ctx), true);
  assert.equal(evalCondition("planner.output.score > 100 and gate.choice == 'approve'", ctx), false);
});

test("in / not in", () => {
  assert.equal(evaluate("'email' in workflow.input.tags", ctx), true);
  assert.equal(evaluate("'weekly' in workflow.input.tags", ctx), false);
  assert.equal(evaluate("'weekly' not in workflow.input.tags", ctx), true);
  assert.equal(evaluate("'cme' in workflow.input.repo", ctx), true); // substring
});

test("arithmetic and string concat", () => {
  assert.equal(evaluate("planner.output.score + 1", ctx), 10);
  assert.equal(evaluate("planner.output.items.length * 2", ctx), 6);
  assert.equal(evaluate("'v' + planner.output.score", ctx), "v9");
  assert.equal(evaluate("10 % 3", {}), 1);
});

test("filters", () => {
  assert.equal(evaluate("missing | default('n/a')", ctx), "n/a");
  assert.equal(evaluate("planner.output.label | default('n/a')", ctx), "ready");
  assert.equal(evaluate("planner.output.items | length", ctx), 3);
  assert.equal(evaluate("planner.output.label | upper", ctx), "READY");
  assert.equal(evaluate("workflow.input.tags | join(', ')", ctx), "email, daily");
  assert.equal(evaluate("planner.output.items | first", ctx), 1);
  assert.equal(evaluate("planner.output.items | last", ctx), 3);
  assert.equal(evaluate("'  hi ' | trim", ctx), "hi");
  assert.equal(evaluate("empty.output | length", ctx), 0);
  assert.equal(evaluate("planner.output | keys | length", ctx), 4);
  // chained filter then comparison binds as (x|length) > 2
  assert.equal(evalCondition("planner.output.items | length > 2", ctx), true);
});

test("renderTemplate: multiple substitutions + JSON for objects", () => {
  assert.equal(renderTemplate("repo={{ workflow.input.repo }} score={{ planner.output.score }}", ctx), "repo=acme/app score=9");
  assert.equal(renderTemplate("tags={{ workflow.input.tags }}", ctx), 'tags=["email","daily"]');
  assert.equal(renderTemplate("missing=[{{ nope.here }}]", ctx), "missing=[]");
  assert.equal(renderTemplate("n+1={{ planner.output.score + 1 }}", ctx), "n+1=10");
  assert.equal(renderTemplate("no placeholders", ctx), "no placeholders");
});

test("evalCondition fails CLOSED on malformed / empty", () => {
  assert.equal(evalCondition("this is not valid ((", ctx), false);
  assert.equal(evalCondition("", ctx), false);
  assert.equal(evalCondition("{{ }}", ctx), false);
  assert.equal(evalCondition("score >>> 3", ctx), false);
});

test("renderTemplate fails LOUD on malformed substitution", () => {
  assert.throws(() => renderTemplate("x={{ 1 +++ }}", ctx), TemplateError);
  assert.throws(() => renderTemplate("x={{ 'unterminated }}", ctx), TemplateError);
});

test("SANDBOX: no prototype-chain climb, no code execution", () => {
  // Blocked keys resolve to undefined — cannot reach the constructor.
  assert.equal(evaluate("workflow.constructor", ctx), undefined);
  assert.equal(evaluate("workflow.__proto__", ctx), undefined);
  assert.equal(evaluate("planner.output.constructor.constructor", ctx), undefined);
  // The classic RCE gadget must NOT execute — it can only read data, and the path dead-ends.
  const marker = { pwned: false };
  const c = { ...ctx, sink: marker };
  // Even though `sink` exists, there is no call syntax in the grammar; a filter is the only
  // callable and the whitelist has no exec. This just resolves to a value, runs nothing.
  assert.equal(evaluate("sink.pwned", c), false);
  assert.equal(marker.pwned, false);
  // `toString`/inherited methods are not own props → undefined, never invoked.
  assert.equal(evaluate("workflow.input.repo.toString", ctx), undefined);
});

test("unknown filter throws (not silently ignored)", () => {
  assert.throws(() => evaluate("x | danger", { x: 1 }), TemplateError);
});

test("DoS guards: depth, size, length bounded", () => {
  const deep = "(".repeat(200) + "1" + ")".repeat(200);
  assert.throws(() => evaluate(deep, {}), TemplateError);
  const long = "a" + "+a".repeat(5000);
  assert.throws(() => evaluate(long, { a: 1 }), TemplateError);
});
