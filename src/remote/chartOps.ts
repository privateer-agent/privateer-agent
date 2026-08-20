// The wire contract for CLI → app Chart operations, shared by the three modules that
// have to agree on it: RelayClient (sends the frames), RemoteBridge (correlates the
// reply), and the chart tools (validate before either runs).
//
// WHY THE ROUND TRIP EXISTS AT ALL. Identical to cargoSave.ts, and for the same reason:
// a chart's content is ciphertext under the account master key — `encryptedTitle` on the
// graph, `encryptedPrompt` / `encryptedAiResponse` / `encryptedNoteBody` on every node —
// and the terminal deliberately holds no master key (crypto/accountVerify.ts). A CLI that
// POSTed /api/graph by itself could only write cards nothing can open, and could not read
// back a single one. So it hands the app plaintext over the relay the user already trusts,
// and the app — already signed in, already holding the key, already owning graphService —
// does the encrypting and the POSTing. No new endpoint, no new key path.
//
// WHY THIS IS NOT JUST cargo's WIRE AGAIN. Cargo is one-way and one-shot: send an
// artifact, get an id. A chart is a structure the user is editing on a canvas WHILE the
// agent writes to it, so this contract carries four ops (list / read / create / edit)
// rather than one, and `edit` is a list of operations rather than a replacement document.
// Handing over a whole chart to overwrite would clobber whatever the user just typed.
//
// WHY NO CHUNKING. Cargo chunks because an artifact runs to 512 KB against a 256 KB frame
// cap. Charts don't get to be that big, on purpose: a node body is capped at MAX_NODE_BODY
// characters (a card someone reads on a phone, not a document), a call touches at most
// MAX_NODES_PER_OP of them, and a `read` truncates each body to READ_BODY_CHARS before it
// comes back. That last cap is as much about the model as the wire — a full chart dumped
// into context is expensive and mostly noise when the agent only needs to know what is
// already there. If media nodes land later they will need chunked binary, and that is the
// point to revisit this; until then one frame each way keeps both ends simple.

/**
 * What a card IS, in the vocabulary the model gets. Deliberately NOT the server's
 * `nodeType` enum, which is `entry | standard | note | file | drawing` and does not mean
 * what it looks like: a picture on the canvas is a `standard` node with attachments and
 * NO prompt (GraphViewScreen.tsx's image drop), a `drawing` is not a card at all but the
 * chart's single freehand ink layer, and an `entry` is bookkeeping the create path owns.
 * Handing that enum to a model gets you cards that render empty and a corrupted ink layer.
 *
 * So the tools speak in card kinds and the app maps them to fields:
 *   note   → nodeType 'note',     body      → encryptedNoteBody
 *   answer → nodeType 'standard', prompt    → encryptedPrompt
 *                                 answer    → encryptedAiResponse  (+ the real modelId)
 *
 * `answer` is not a fancier `note`. Because it carries a genuine prompt/response pair it
 * is a card the user can tap in the app and keep asking questions from — the branch
 * continues under the app's model. A note is inert text. That difference is the reason
 * both exist, and the tool descriptions say so.
 */
export const CHART_NODE_KINDS = ["note", "answer"] as const;
export type ChartNodeKind = (typeof CHART_NODE_KINDS)[number];

export function isChartNodeKind(v: unknown): v is ChartNodeKind {
  return typeof v === "string" && (CHART_NODE_KINDS as readonly string[]).includes(v);
}

// ── Ceilings ────────────────────────────────────────────────────────────────────
//
// Every one of these is enforced on THIS side, where the message can name the offending
// node and say what to do, rather than arriving as a save failure the model can only
// report as "it didn't work".

/** Characters in a single card's body (or its answer). A card is read on a phone. */
export const MAX_NODE_BODY = 8_000;

/** Characters in an `answer` card's prompt — a question, not an essay. */
export const MAX_NODE_PROMPT = 2_000;

/** Characters in a chart title. Mirrors chatGraphModel's `maxlength: 100`. */
export const MAX_TITLE = 100;

/** Characters in an edge label. Mirrors chatEdgeModel's own cap. */
export const MAX_EDGE_LABEL = 60;

/**
 * Cards one call may create or touch. The in-app fan-out ceiling is 6 (utils/multiNode
 * MAX_FANOUT), but that bounds one prompt spawning siblings; a chart being drawn as a map
 * legitimately wants more. 12 is where a canvas is still pannable — past it the user gets
 * a wall they scroll once and never open again, which is a worse outcome than a refusal.
 */
export const MAX_NODES_PER_OP = 12;

/**
 * Cards a `read` returns, newest first. A chart the user has been working in for months
 * can hold far more than the agent needs to decide where a new card goes.
 */
export const MAX_READ_NODES = 60;

/** Characters of each card's text a `read` returns before truncating. */
export const READ_BODY_CHARS = 1_500;

/** Charts a `list` returns. */
export const MAX_LIST_CHARTS = 50;

/**
 * Bytes one request frame may occupy, checked on the serialized JSON.
 *
 * The per-field caps above are in CHARACTERS, and the relay's ceiling is in BYTES
 * (`maxPayload: 256 * 1024` on the server's WebSocketServer). For English those are close
 * enough to ignore; for Japanese, Thai, Hindi or Arabic they are not — twelve cards of
 * 8,000 CJK characters each is roughly 288 KB of UTF-8 and the socket would drop the frame
 * with no reply at all, which the tool could only report as a timeout. So the real ceiling
 * is measured where it actually binds, with headroom for the envelope.
 */
export const MAX_REQUEST_BYTES = 200 * 1024;

/**
 * Is this request small enough to survive the relay? Returns a problem for the model, or
 * null. Takes the already-built request so what is measured is exactly what is sent.
 */
export function checkRequestSize(req: ChartOpRequest): string | null {
  const bytes = Buffer.byteLength(JSON.stringify(req), "utf8");
  if (bytes <= MAX_REQUEST_BYTES) return null;
  return (
    `this call is ${Math.round(bytes / 1024)} KB, over the ${MAX_REQUEST_BYTES / 1024} KB a single relay frame can carry. ` +
    `Split it into fewer cards per call, or shorten them — a card is meant to be read on a phone.`
  );
}

// ── Requests ────────────────────────────────────────────────────────────────────

/** A card to create. Which fields are required depends on `kind` — see validateNewNode. */
export interface NewChartNode {
  kind: ChartNodeKind;
  /**
   * A handle for THIS call only, so edges and `parent` can name a card that does not
   * exist yet. The app maps refs to real ids as it creates them. Ids are minted by the
   * server; a model cannot know one in advance, so without refs a create could only ever
   * produce disconnected cards — which is not a chart, it's a pile.
   */
  ref?: string;
  /** `note` only: the markdown body. */
  body?: string;
  /** `answer` only: the question this card answers. */
  prompt?: string;
  /** `answer` only: the response. */
  answer?: string;
  /**
   * A `ref` from this same call, or an existing node id, to hang this card under. The app
   * draws the edge AND uses it to lay the card out — position is deliberately not on this
   * interface, because a model asked for coordinates produces overlapping cards and the
   * app already knows how to place them (utils/multiNode computeFanoutPositions).
   */
  parent?: string;
}

/** An edge to draw between two cards, each named by `ref` or by existing node id. */
export interface NewChartEdge {
  from: string;
  to: string;
  label?: string;
  /** Default true. A directional edge reads as "leads to"; bidirectional as "relates to". */
  directional?: boolean;
}

/** One step of an `edit`. Applied in order, and the first failure stops the rest. */
export type ChartEditOp =
  | { edit: "add_node"; node: NewChartNode }
  | { edit: "update_node"; nodeId: string; body?: string; prompt?: string; answer?: string }
  | { edit: "connect"; edge: NewChartEdge }
  | { edit: "delete_node"; nodeId: string }
  | { edit: "rename"; title: string };

export type ChartOpRequest =
  | { op: "list" }
  | { op: "read"; chartId: string }
  | { op: "create"; title?: string; nodes: NewChartNode[]; edges?: NewChartEdge[] }
  | { op: "edit"; chartId: string; ops: ChartEditOp[] };

// ── Replies ─────────────────────────────────────────────────────────────────────

export interface ChartSummary {
  chartId: string;
  title: string;
  nodeCount: number;
  updatedAt?: string;
}

export interface ChartNodeView {
  nodeId: string;
  kind: ChartNodeKind | "other";
  /** The card's text, truncated to READ_BODY_CHARS. For `answer` cards, the response. */
  text: string;
  /** `answer` cards only: the question. */
  prompt?: string;
  truncated?: boolean;
}

export interface ChartEdgeView {
  from: string;
  to: string;
  label?: string;
  directional: boolean;
}

/**
 * The app's answer. `ok: false` carries a reason written for a person — a locked vault, a
 * chart cap, a guest session — because the tool hands it straight to the model, and
 * "failed" is not something it can act on.
 *
 * `storageType` rides on the write results for the same reason cargo's does: a chart in a
 * local-backend project never touches the server, and the user is owed the difference.
 */
export type ChartOpResult =
  | { ok: true; op: "list"; charts: ChartSummary[] }
  | {
      ok: true;
      op: "read";
      chart: ChartSummary;
      nodes: ChartNodeView[];
      edges: ChartEdgeView[];
      /** True when the chart holds more cards than MAX_READ_NODES and this is a slice. */
      partial?: boolean;
    }
  | { ok: true; op: "create"; chartId: string; title: string; nodeIds: string[]; storageType: string }
  | { ok: true; op: "edit"; chartId: string; applied: number; nodeIds: string[] }
  | { ok: false; reason: string };

// ── Validation ──────────────────────────────────────────────────────────────────
//
// Shared by the tools (before anything is sent) and worth keeping here rather than in the
// tool file: the app trusts what arrives on this wire enough to write it into the user's
// account, so the rules that decide what is well-formed belong with the contract, not
// with one caller of it.

/** Human-readable problem, or null when the card is well-formed. */
export function validateNewNode(node: NewChartNode, where: string): string | null {
  if (!node || typeof node !== "object") return `${where}: not an object.`;
  if (!isChartNodeKind(node.kind)) {
    return `${where}: kind must be one of ${CHART_NODE_KINDS.join(", ")} (got ${JSON.stringify(node.kind)}).`;
  }
  if (node.kind === "note") {
    // Refused rather than coerced: a note whose text was passed as `answer` would store an
    // empty card, and the user finds that out on their phone. Same call cargo makes on a
    // kind that contradicts its extension.
    if (!node.body || !node.body.trim()) return `${where}: a note card needs \`body\` (its markdown text).`;
    if (node.prompt || node.answer) return `${where}: a note card takes \`body\` only — use kind "answer" to store a question and its response.`;
    if (node.body.length > MAX_NODE_BODY) return `${where}: body is ${node.body.length} characters; a card caps at ${MAX_NODE_BODY}. Split it across cards.`;
  } else {
    if (!node.prompt || !node.prompt.trim()) return `${where}: an answer card needs \`prompt\` (the question it answers).`;
    if (!node.answer || !node.answer.trim()) return `${where}: an answer card needs \`answer\` (the response).`;
    if (node.body) return `${where}: an answer card takes \`prompt\` + \`answer\` — use kind "note" for plain text.`;
    if (node.prompt.length > MAX_NODE_PROMPT) return `${where}: prompt is ${node.prompt.length} characters; it caps at ${MAX_NODE_PROMPT}. It should read as a question.`;
    if (node.answer.length > MAX_NODE_BODY) return `${where}: answer is ${node.answer.length} characters; a card caps at ${MAX_NODE_BODY}. Split it across cards.`;
  }
  return null;
}

/** Human-readable problem with an edge, or null. `known` is every name an edge may use. */
export function validateEdge(edge: NewChartEdge, known: Set<string>, where: string): string | null {
  if (!edge || typeof edge !== "object") return `${where}: not an object.`;
  if (!edge.from || !edge.to) return `${where}: needs both \`from\` and \`to\`.`;
  if (edge.from === edge.to) return `${where}: an edge can't join a card to itself.`;
  // Only refs are checkable here — an id belongs to a chart this process has never seen,
  // so it is left to the app, which is the only end that can tell a real id from a typo.
  for (const end of [edge.from, edge.to]) {
    if (!known.has(end) && !looksLikeNodeId(end)) {
      return `${where}: "${end}" is neither a \`ref\` in this call nor a node id. Known refs: ${[...known].join(", ") || "none"}.`;
    }
  }
  if (edge.label && edge.label.length > MAX_EDGE_LABEL) return `${where}: label caps at ${MAX_EDGE_LABEL} characters.`;
  return null;
}

/**
 * Re-type an inbound `chart_result` payload off the wire. Nothing is trusted: the id keys
 * a pending tool call and the rest is quoted straight to the model, so a malformed frame
 * has to degrade into a refusal with a reason rather than an `undefined` the tool prints.
 * Same posture as RelayClient's cargo_saved handling, factored out here because there are
 * four result shapes to check instead of one.
 */
export function parseChartResult(raw: unknown): ChartOpResult {
  const refuse = (reason: string): ChartOpResult => ({ ok: false, reason });
  if (!raw || typeof raw !== "object") return refuse("the app sent an unreadable answer");
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) {
    return refuse(typeof r.reason === "string" && r.reason ? r.reason : "the app refused the operation without giving a reason");
  }
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  switch (r.op) {
    case "list":
      return {
        ok: true,
        op: "list",
        charts: arr(r.charts).map((c) => {
          const o = (c ?? {}) as Record<string, unknown>;
          return {
            chartId: str(o.chartId),
            title: str(o.title),
            nodeCount: typeof o.nodeCount === "number" ? o.nodeCount : 0,
            updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
          };
        }).filter((c) => c.chartId),
      };
    case "read": {
      const chart = (r.chart ?? {}) as Record<string, unknown>;
      if (!str(chart.chartId)) return refuse("the app answered a read with no chart");
      return {
        ok: true,
        op: "read",
        chart: {
          chartId: str(chart.chartId),
          title: str(chart.title),
          nodeCount: typeof chart.nodeCount === "number" ? chart.nodeCount : 0,
          updatedAt: typeof chart.updatedAt === "string" ? chart.updatedAt : undefined,
        },
        nodes: arr(r.nodes).map((n) => {
          const o = (n ?? {}) as Record<string, unknown>;
          return {
            nodeId: str(o.nodeId),
            kind: isChartNodeKind(o.kind) ? o.kind : ("other" as const),
            text: str(o.text),
            prompt: typeof o.prompt === "string" ? o.prompt : undefined,
            truncated: o.truncated === true ? true : undefined,
          };
        }).filter((n) => n.nodeId),
        edges: arr(r.edges).map((e) => {
          const o = (e ?? {}) as Record<string, unknown>;
          return {
            from: str(o.from),
            to: str(o.to),
            label: typeof o.label === "string" && o.label ? o.label : undefined,
            directional: o.directional !== false,
          };
        }).filter((e) => e.from && e.to),
        partial: r.partial === true ? true : undefined,
      };
    }
    case "create": {
      const chartId = str(r.chartId);
      if (!chartId) return refuse("the app answered a create with no chart id");
      return {
        ok: true,
        op: "create",
        chartId,
        title: str(r.title),
        nodeIds: arr(r.nodeIds).filter((v): v is string => typeof v === "string"),
        storageType: r.storageType === "local" ? "local" : "cloud",
      };
    }
    case "edit":
      return {
        ok: true,
        op: "edit",
        chartId: str(r.chartId),
        applied: typeof r.applied === "number" ? r.applied : 0,
        nodeIds: arr(r.nodeIds).filter((v): v is string => typeof v === "string"),
      };
    default:
      return refuse("the app answered with an operation this version doesn't understand");
  }
}

/**
 * Could this string be a server node id? Mongo ObjectIds are 24 hex characters; a
 * local-backend chart mints 32-char hex ids instead (graphService's isLocalProject note).
 * Accept either, and nothing else — the point is only to tell "an id I can't verify here"
 * apart from "a ref you forgot to declare", so the error message can say which.
 */
export function looksLikeNodeId(s: string): boolean {
  return /^[a-f0-9]{24}$/i.test(s) || /^[a-f0-9]{32}$/i.test(s);
}
