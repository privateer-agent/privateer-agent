// The Chart tools — read and write the boards in the user's Privateer app ("Charts" in
// the UI; `graph` everywhere in the code and the API, which is why this file keeps saying
// chart to the model and graph to the wire).
//
// The interesting part is not this file, it's why every one of these is a round trip
// through the app — src/remote/chartOps.ts has that. What matters here is the shape that
// follows from it:
//
// THE MODEL NEVER SEES THE SCHEMA. A card on the canvas is not "pick a nodeType": an
// image card is a `standard` node with attachments and no prompt, a `drawing` is the ink
// layer rather than a card, and an `entry` is bookkeeping. A model handed that enum
// produces cards that render empty. So the tools speak two kinds — `note` and `answer` —
// and the app maps them to fields. Adding a kind means teaching the app, not widening this.
//
// THE MODEL NEVER DOES LAYOUT. There is no `position` anywhere in these parameters. Ask a
// model for coordinates and you get overlapping cards; the app already knows how to place
// them (computeFanoutPositions). The model supplies structure — what hangs off what — and
// `parent` is how it says so.
//
// REFUSES RATHER THAN GUESSES. Same call cargo.ts makes about a mismatched kind, for the
// same reason: a note whose text arrived as `answer` stores a blank card, and the user
// discovers that later, on their phone, with no way to tell what went wrong. So a
// malformed card is an error naming the card and the fix, checked here — before a single
// frame goes out — rather than after four of twelve cards have already landed.
//
// SAYS WHERE IT LANDED. Like save_cargo, these writes are genuinely end-to-end encrypted:
// the app encrypts on the device and the server stores ciphertext it cannot read. That is
// the opposite of the generate_* tools' posture, so the descriptions state it plainly and
// the success lines repeat it.

import { Type } from "typebox";
import {
  MAX_NODES_PER_OP,
  MAX_TITLE,
  checkRequestSize,
  looksLikeNodeId,
  validateEdge,
  validateNewNode,
  type ChartEditOp,
  type ChartOpRequest,
  type ChartOpResult,
  type NewChartEdge,
  type NewChartNode,
} from "../remote/chartOps.ts";

function text(t: string) {
  return { content: [{ type: "text", text: t }], details: {} };
}

/** The bridge surface these tools need; RemoteBridge implements it. */
export interface ChartOpBridge {
  chartOpRemote(req: ChartOpRequest, signal?: AbortSignal): Promise<ChartOpResult>;
}

export const CHART_TOOL_NAMES = ["list_charts", "read_chart", "create_chart", "edit_chart"] as const;

// Shared prose. Repeated in every description on purpose: a model that reads only one of
// these tools must still learn that the app has to be attached and that the two card kinds
// are not interchangeable.
const NEEDS_APP =
  "Needs the Privateer app attached to this terminal: the app holds the key, so it is the only end that can " +
  "open a chart or encrypt a new card. Nothing readable by the server is ever stored.";

const KIND_NOTE =
  '"note" — a markdown card you wrote. Inert text the user reads.';
const KIND_ANSWER =
  '"answer" — a question and its response. The user can tap this card in the app and keep the branch going ' +
  "with their own model, which a note cannot do. Prefer it whenever the card IS an answer to something.";

/** The card sub-schema, shared by create_chart and edit_chart. */
const NODE_SCHEMA = Type.Object({
  kind: Type.String({ description: `What the card is. ${KIND_NOTE} ${KIND_ANSWER}` }),
  ref: Type.Optional(
    Type.String({
      description:
        'A short handle for this card within THIS call (e.g. "auth", "db"), so other cards can name it as ' +
        "their `parent` and edges can join it. Ids are minted by the server, so without a ref you cannot " +
        "connect cards you are creating in the same call.",
    }),
  ),
  body: Type.Optional(Type.String({ description: 'The markdown text. Required for kind "note", and only for it.' })),
  prompt: Type.Optional(Type.String({ description: 'The question this card answers. Required for kind "answer".' })),
  answer: Type.Optional(Type.String({ description: 'The response. Required for kind "answer".' })),
  parent: Type.Optional(
    Type.String({
      description:
        "A `ref` from this call, or an existing node id, to hang this card under. Draws the edge and decides " +
        "where the card is placed — this is how you express structure, since there are no coordinates.",
    }),
  ),
});

const EDGE_SCHEMA = Type.Object({
  from: Type.String({ description: "A `ref` from this call, or an existing node id." }),
  to: Type.String({ description: "A `ref` from this call, or an existing node id." }),
  label: Type.Optional(Type.String({ description: 'What the connection means, e.g. "calls", "depends on". Kept short.' })),
  directional: Type.Optional(
    Type.Boolean({ description: 'Default true ("leads to"). False draws an undirected "relates to" link.' }),
  ),
});

// ── shared validation ────────────────────────────────────────────────────────

/**
 * Check a set of cards and edges as a batch, returning the first problem or null. Batched
 * rather than per-card because `ref` resolution is a property of the whole call: an edge
 * naming a ref that no card declares is only detectable once every card has been seen.
 */
function validateBatch(nodes: NewChartNode[], edges: NewChartEdge[], nodeLabel: string): string | null {
  if (nodes.length > MAX_NODES_PER_OP) {
    return (
      `${nodes.length} cards is more than one call can add (max ${MAX_NODES_PER_OP}). ` +
      `A chart is something the user pans around — split this across calls, or say less per card.`
    );
  }
  const refs = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const problem = validateNewNode(nodes[i], `${nodeLabel}[${i}]`);
    if (problem) return problem;
    const ref = nodes[i].ref;
    if (ref) {
      if (refs.has(ref)) return `${nodeLabel}[${i}]: ref "${ref}" is used twice — refs must be unique within a call.`;
      refs.add(ref);
    }
  }
  // A parent must resolve to something. Checked after every ref is known, so declaration
  // order doesn't matter — the app resolves the graph, not the array.
  for (let i = 0; i < nodes.length; i++) {
    const parent = nodes[i].parent;
    if (parent && !refs.has(parent) && !looksLikeNodeId(parent)) {
      return `${nodeLabel}[${i}]: parent "${parent}" is neither a \`ref\` in this call nor a node id. Known refs: ${[...refs].join(", ") || "none"}.`;
    }
  }
  for (let i = 0; i < edges.length; i++) {
    const problem = validateEdge(edges[i], refs, `edges[${i}]`);
    if (problem) return problem;
  }
  return null;
}

/** Render a read result as an outline. Cheaper to read than JSON, for a person or a model. */
function renderChart(r: Extract<ChartOpResult, { op: "read" }>): string {
  const lines: string[] = [];
  lines.push(`Chart "${r.chart.title}" (${r.chart.chartId}) — ${r.chart.nodeCount} cards`);
  if (r.partial) lines.push(`(showing the ${r.nodes.length} most recent)`);
  lines.push("");
  if (r.nodes.length === 0) {
    lines.push("No cards yet.");
  } else {
    for (const n of r.nodes) {
      const head = n.kind === "answer" && n.prompt ? `[${n.kind}] ${n.nodeId} — ${n.prompt}` : `[${n.kind}] ${n.nodeId}`;
      lines.push(head);
      if (n.text) lines.push(`    ${n.text.replace(/\n/g, "\n    ")}${n.truncated ? " …(truncated)" : ""}`);
    }
  }
  if (r.edges.length > 0) {
    lines.push("");
    lines.push("Connections:");
    for (const e of r.edges) {
      lines.push(`  ${e.from} ${e.directional ? "→" : "—"} ${e.to}${e.label ? ` (${e.label})` : ""}`);
    }
  }
  return lines.join("\n");
}

// ── list_charts ──────────────────────────────────────────────────────────────

export function makeListChartsTool(bridge: ChartOpBridge) {
  return {
    name: "list_charts",
    label: "List charts",
    description:
      "List the charts (visual boards of connected cards) in the user's Privateer app, with their titles and " +
      "card counts. Use it to find the chart the user means before reading or editing one — chart ids are not " +
      "guessable and a title alone is not one. " +
      NEEDS_APP,
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: Record<string, never>, signal?: AbortSignal) {
      const res = await bridge.chartOpRemote({ op: "list" }, signal);
      if (!res.ok) return text(`Could not list charts: ${res.reason}`);
      if (res.op !== "list") return text("The app answered the wrong kind of result.");
      if (res.charts.length === 0) return text("No charts yet. create_chart makes the first one.");
      const lines = res.charts.map((c) => `${c.chartId}  ${c.title || "(untitled)"} — ${c.nodeCount} cards`);
      return text(`${res.charts.length} chart${res.charts.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
    },
  };
}

// ── read_chart ───────────────────────────────────────────────────────────────

export function makeReadChartTool(bridge: ChartOpBridge) {
  return {
    name: "read_chart",
    label: "Read a chart",
    description:
      "Read a chart's cards and the connections between them. The app decrypts it on the device — this is the " +
      "user's stored content, so read one because the work needs it, not to browse. " +
      "Do this BEFORE edit_chart: card ids come from here, and adding to a chart you haven't looked at is how " +
      "you end up with duplicates of cards that were already there. Long cards come back truncated. " +
      NEEDS_APP,
    parameters: Type.Object({
      chartId: Type.String({ description: "The chart's id, from list_charts or from a create_chart you just made." }),
    }),
    async execute(_toolCallId: string, params: { chartId: string }, signal?: AbortSignal) {
      if (!params.chartId) return text("Error: chartId is required — run list_charts to find it.");
      const res = await bridge.chartOpRemote({ op: "read", chartId: params.chartId }, signal);
      if (!res.ok) return text(`Could not read the chart: ${res.reason}`);
      if (res.op !== "read") return text("The app answered the wrong kind of result.");
      return text(renderChart(res));
    },
  };
}

// ── create_chart ─────────────────────────────────────────────────────────────

export function makeCreateChartTool(bridge: ChartOpBridge) {
  return {
    name: "create_chart",
    label: "Create a chart",
    description:
      "Create a new chart in the user's Privateer app — a canvas of cards they can open, pan around, and keep " +
      "working in from any signed-in device. Use it when the thing you have to show HAS STRUCTURE worth seeing: " +
      "subsystems and how they connect, a set of options and their trade-offs, the branches of an investigation. " +
      "For a linear answer, a plain reply is better; for a single document, use save_cargo.\n" +
      `Two card kinds. ${KIND_NOTE} ${KIND_ANSWER}\n` +
      "Structure, not coordinates: give each card a short `ref` and set `parent` (or list `edges`) to say what " +
      "hangs off what. The app lays them out. " +
      `At most ${MAX_NODES_PER_OP} cards per call — add more with edit_chart. ` +
      NEEDS_APP,
    parameters: Type.Object({
      nodes: Type.Array(NODE_SCHEMA, {
        description: `The cards to create, at most ${MAX_NODES_PER_OP}. The first card with no \`parent\` becomes the chart's starting point.`,
      }),
      title: Type.Optional(
        Type.String({
          description:
            "Title for the chart, the way the user would name it. Omitted → the app derives one from the first " +
            `card's text, which is usually fine. Max ${MAX_TITLE} characters.`,
        }),
      ),
      edges: Type.Optional(
        Type.Array(EDGE_SCHEMA, {
          description:
            "Extra connections beyond the parent links — cross-links, or edges that need a label. Most charts " +
            "need none of these.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { nodes: NewChartNode[]; title?: string; edges?: NewChartEdge[] },
      signal?: AbortSignal,
    ) {
      const nodes = Array.isArray(params.nodes) ? params.nodes : [];
      const edges = Array.isArray(params.edges) ? params.edges : [];
      if (nodes.length === 0) return text("Error: a chart needs at least one card — pass `nodes`.");
      if (params.title && params.title.length > MAX_TITLE) {
        return text(`Title is ${params.title.length} characters; it caps at ${MAX_TITLE}.`);
      }
      const problem = validateBatch(nodes, edges, "nodes");
      if (problem) return text(problem);

      const req: ChartOpRequest = { op: "create", title: params.title, nodes, edges };
      // Measured on the built request, because the per-field caps are in characters and
      // the relay's is in bytes — see checkRequestSize.
      const oversize = checkRequestSize(req);
      if (oversize) return text(oversize);

      const res = await bridge.chartOpRemote(req, signal);
      if (!res.ok) return text(`Could not create the chart: ${res.reason}`);
      if (res.op !== "create") return text("The app answered the wrong kind of result.");
      const where = res.storageType === "local" ? "on the device" : "encrypted on the device and stored";
      return text(
        `Created "${res.title}" with ${res.nodeIds.length} card${res.nodeIds.length === 1 ? "" : "s"} — ${where}. ` +
          `Chart id ${res.chartId}. It's in Charts in the app now; edit_chart adds to it.`,
      );
    },
  };
}

// ── edit_chart ───────────────────────────────────────────────────────────────

export function makeEditChartTool(bridge: ChartOpBridge) {
  return {
    name: "edit_chart",
    label: "Edit a chart",
    description:
      "Change an existing chart: add cards, rewrite one, connect two, delete one, or rename the chart. Steps are " +
      "applied in order and stop at the first failure, so put the cards before the edges that join them.\n" +
      "Read the chart first (read_chart) — every `nodeId` here comes from there, and it is also how you avoid " +
      "adding a card the user already has. New cards can carry a `ref` so later steps in the same call can " +
      "connect them. " +
      `At most ${MAX_NODES_PER_OP} new cards per call. ` +
      NEEDS_APP,
    parameters: Type.Object({
      chartId: Type.String({ description: "The chart to change, from list_charts or read_chart." }),
      ops: Type.Array(
        Type.Object({
          edit: Type.String({
            description:
              'One of: "add_node" (needs `node`), "update_node" (needs `nodeId` plus the fields to rewrite), ' +
              '"connect" (needs `edge`), "delete_node" (needs `nodeId`), "rename" (needs `title`).',
          }),
          node: Type.Optional(NODE_SCHEMA),
          nodeId: Type.Optional(Type.String({ description: "The card to change or remove, from read_chart." })),
          body: Type.Optional(Type.String({ description: "update_node: new markdown text for a note card." })),
          prompt: Type.Optional(Type.String({ description: "update_node: new question for an answer card." })),
          answer: Type.Optional(Type.String({ description: "update_node: new response for an answer card." })),
          edge: Type.Optional(EDGE_SCHEMA),
          title: Type.Optional(Type.String({ description: "rename: the chart's new title." })),
        }),
        { description: "The steps to apply, in order." },
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { chartId: string; ops: Array<Record<string, any>> },
      signal?: AbortSignal,
    ) {
      if (!params.chartId) return text("Error: chartId is required — run list_charts to find it.");
      const raw = Array.isArray(params.ops) ? params.ops : [];
      if (raw.length === 0) return text("Error: `ops` is empty — say what to change.");

      // Normalize into the wire shape, refusing anything half-specified. Done here rather
      // than on the app side so the message can name the step and what it is missing —
      // the app can only answer "step 3 failed", by which point steps 1 and 2 have landed.
      const ops: ChartEditOp[] = [];
      const newNodes: NewChartNode[] = [];
      const newEdges: NewChartEdge[] = [];
      for (let i = 0; i < raw.length; i++) {
        const o = raw[i] ?? {};
        const at = `ops[${i}]`;
        switch (o.edit) {
          case "add_node": {
            if (!o.node) return text(`${at}: add_node needs \`node\`.`);
            newNodes.push(o.node);
            ops.push({ edit: "add_node", node: o.node });
            break;
          }
          case "update_node": {
            if (!o.nodeId) return text(`${at}: update_node needs \`nodeId\` (from read_chart).`);
            // Shape-checked here because the server can't: a nodeId that isn't an id
            // fails Mongo's ObjectId cast, which surfaces as "Server error: 500" — a
            // message the model can do nothing with, on a step that has already let
            // earlier steps land.
            if (!looksLikeNodeId(o.nodeId)) return text(`${at}: "${o.nodeId}" is not a node id. Run read_chart and use the ids it lists.`);
            if (o.body === undefined && o.prompt === undefined && o.answer === undefined) {
              return text(`${at}: update_node needs at least one of \`body\`, \`prompt\` or \`answer\`.`);
            }
            // A note card has a body and an answer card has a prompt/answer pair; mixing
            // them in one update is a card that would render half-blank either way.
            if (o.body !== undefined && (o.prompt !== undefined || o.answer !== undefined)) {
              return text(`${at}: update_node takes \`body\` (a note card) or \`prompt\`/\`answer\` (an answer card), not both.`);
            }
            ops.push({ edit: "update_node", nodeId: o.nodeId, body: o.body, prompt: o.prompt, answer: o.answer });
            break;
          }
          case "connect": {
            if (!o.edge) return text(`${at}: connect needs \`edge\` with \`from\` and \`to\`.`);
            newEdges.push(o.edge);
            ops.push({ edit: "connect", edge: o.edge });
            break;
          }
          case "delete_node": {
            if (!o.nodeId) return text(`${at}: delete_node needs \`nodeId\` (from read_chart).`);
            if (!looksLikeNodeId(o.nodeId)) return text(`${at}: "${o.nodeId}" is not a node id. Run read_chart and use the ids it lists.`);
            ops.push({ edit: "delete_node", nodeId: o.nodeId });
            break;
          }
          case "rename": {
            if (!o.title || !String(o.title).trim()) return text(`${at}: rename needs \`title\`.`);
            if (String(o.title).length > MAX_TITLE) return text(`${at}: title caps at ${MAX_TITLE} characters.`);
            ops.push({ edit: "rename", title: String(o.title) });
            break;
          }
          default:
            return text(
              `${at}: "${o.edit}" is not an edit. Use add_node, update_node, connect, delete_node or rename.`,
            );
        }
      }

      const problem = validateBatch(newNodes, newEdges, "added cards");
      if (problem) return text(problem);

      const req: ChartOpRequest = { op: "edit", chartId: params.chartId, ops };
      const oversize = checkRequestSize(req);
      if (oversize) return text(oversize);

      const res = await bridge.chartOpRemote(req, signal);
      if (!res.ok) return text(`Could not edit the chart: ${res.reason}`);
      if (res.op !== "edit") return text("The app answered the wrong kind of result.");
      const added = res.nodeIds.length;
      return text(
        `Applied ${res.applied} of ${ops.length} step${ops.length === 1 ? "" : "s"} to the chart` +
          (added ? `, adding ${added} card${added === 1 ? "" : "s"}` : "") +
          `. Anything stored was encrypted on the device first.`,
      );
    },
  };
}

/** All four, for a session that has a bridge to bind them to. */
export function makeChartTools(bridge: ChartOpBridge) {
  return [
    makeListChartsTool(bridge),
    makeReadChartTool(bridge),
    makeCreateChartTool(bridge),
    makeEditChartTool(bridge),
  ];
}
