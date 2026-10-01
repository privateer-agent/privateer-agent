// `/image-model` and `/video-model` — choose which model the media tools generate with
// on this machine when the agent doesn't name one (see config/mediaModels.ts for where
// the choice lives and why it is per machine rather than written to the account).
//
//   /image-model            open a picker over the account's live image catalog
//   /image-model <id>       set it directly (checked against that catalog)
//   /image-model default    clear it — back to the account default
//
// The catalog is the same list the app's own picker reads
// (GET /api/models/openrouter?action=imageGen|videoGen), so the terminal can never
// offer a model the account can't reach. Each row carries its privacy posture, because
// a ZDR account choosing a non-ZDR model will have every generation refused — better
// to see that in the picker than as a failed call later.
import { apiRequest } from "../auth/privateer.ts";
import { mediaModelPref, setMediaModelPref, type MediaKind } from "../config/mediaModels.ts";

export interface CatalogModel {
  id: string;
  name?: string;
  isZdr?: boolean;
  isTee?: boolean;
  supportedDurations?: number[] | null;
  generateAudio?: boolean | null;
  supportsImageToVideo?: boolean;
}

const ACTION: Record<MediaKind, string> = { image: "imageGen", video: "videoGen" };
const RESET = new Set(["default", "reset", "clear", "none", "account"]);

export async function fetchMediaCatalog(
  kind: MediaKind,
): Promise<{ ok: true; models: CatalogModel[] } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await apiRequest(`/api/models/openrouter?action=${ACTION[kind]}`, { method: "GET" });
  } catch (e) {
    return { ok: false, message: `could not reach Privateer: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) {
    if (res.status === 401) return { ok: false, message: "not signed in — run /login first" };
    return { ok: false, message: `Privateer returned ${res.status}` };
  }
  try {
    const body = (await res.json()) as { models?: CatalogModel[] };
    // OpenRouter's auto routers ride along in the image-output list but pick a CHAT
    // model per request — not something a generation can be pinned to.
    const models = (body.models ?? []).filter(
      (m) => m && typeof m.id === "string" && m.id && !m.id.startsWith("openrouter/"),
    );
    return { ok: true, models };
  } catch {
    return { ok: false, message: "Privateer returned a malformed model list" };
  }
}

/** "3-15s" for a contiguous run of whole seconds, "5/10s" otherwise. Pure. */
export function formatDurations(d: number[]): string {
  const s = [...new Set(d)].sort((a, b) => a - b);
  const contiguous = s.length > 2 && s.every((v, i) => i === 0 || v === s[i - 1] + 1);
  return contiguous ? `${s[0]}-${s[s.length - 1]}s` : `${s.join("/")}s`;
}

/** One picker row: name, id, posture, and for video what the model can do. Pure. */
export function describeCatalogRow(m: CatalogModel, kind: MediaKind, current?: string): string {
  const posture = m.isTee ? "confidential" : m.isZdr ? "ZDR" : "non-ZDR";
  const tags = [posture];
  if (kind === "video") {
    if (m.supportedDurations?.length) tags.push(formatDurations(m.supportedDurations));
    if (m.supportsImageToVideo) tags.push("first frame");
    if (m.generateAudio) tags.push("audio");
  }
  const name = m.name && m.name !== m.id ? `${m.name}  ` : "";
  return `${m.id === current ? "● " : "  "}${name}${m.id}  (${tags.join(", ")})`;
}

const LABEL: Record<MediaKind, string> = { image: "Image", video: "Video" };

function nonZdrWarning(m: CatalogModel | undefined): string {
  return m && !m.isZdr && !m.isTee
    ? " — non-ZDR: refused if this account requires Zero Data Retention for media (Settings → Privacy)"
    : "";
}

interface Ui {
  notify?: (msg: string, level?: string) => void;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
}

/**
 * The whole command, minus registration — exported so tests can drive it with a fake
 * ui and a stubbed catalog.
 */
export async function runMediaModelCommand(
  kind: MediaKind,
  args: string,
  ui: Ui | undefined,
  catalog: (kind: MediaKind) => ReturnType<typeof fetchMediaCatalog> = fetchMediaCatalog,
): Promise<void> {
  const say = (msg: string, level = "info") => ui?.notify?.(msg, level);
  const label = LABEL[kind];
  const current = mediaModelPref(kind);
  const arg = String(args ?? "").trim();

  if (RESET.has(arg.toLowerCase())) {
    setMediaModelPref(kind, null);
    say(`${label} model: account default${current ? ` (was ${current})` : ""}`);
    return;
  }

  const list = await catalog(kind);

  if (arg) {
    // A typed id is checked against the live catalog when we can read it — a typo
    // saved here would fail every later generation. When the catalog is unreachable
    // it is saved anyway, with that said: the server still refuses an id it can't serve.
    if (list.ok) {
      const hit = list.models.find((m) => m.id === arg) ?? list.models.find((m) => m.id.toLowerCase() === arg.toLowerCase());
      if (!hit) {
        const near = list.models.filter((m) => m.id.toLowerCase().includes(arg.toLowerCase())).slice(0, 5);
        say(
          `No ${kind} model "${arg}" on this account.` +
            (near.length ? ` Did you mean: ${near.map((m) => m.id).join(", ")}?` : ` Run /${kind}-model to browse.`),
          "warning",
        );
        return;
      }
      setMediaModelPref(kind, hit.id);
      say(`${label} model: ${hit.id}${nonZdrWarning(hit)}`);
      return;
    }
    setMediaModelPref(kind, arg);
    say(`${label} model: ${arg} (couldn't check it against the catalog: ${list.message})`, "warning");
    return;
  }

  if (!list.ok) {
    say(`Couldn't list ${kind} models: ${list.message}`, "error");
    return;
  }
  if (!list.models.length) {
    say(`This account has no ${kind} models available.`, "warning");
    return;
  }
  if (!ui?.select) {
    say(`${label} model: ${current ?? "account default"}. Set one with /${kind}-model <id>.`);
    return;
  }

  const DEFAULT_ROW = `${current ? "  " : "● "}Account default`;
  const rows = list.models.map((m) => describeCatalogRow(m, kind, current));
  const picked = await ui.select(`${label} model for generate_${kind} — current: ${current ?? "account default"}`, [
    DEFAULT_ROW,
    ...rows,
  ]);
  if (picked === undefined) return;
  if (picked === DEFAULT_ROW) {
    setMediaModelPref(kind, null);
    say(`${label} model: account default`);
    return;
  }
  const chosen = list.models[rows.indexOf(picked)];
  if (!chosen) return;
  setMediaModelPref(kind, chosen.id);
  say(`${label} model: ${chosen.id}${nonZdrWarning(chosen)}`);
}

export function registerMediaModelCommands(pi: { registerCommand?: (name: string, opts: unknown) => void }): void {
  for (const kind of ["image", "video"] as const) {
    pi.registerCommand?.(`${kind}-model`, {
      description: `Choose the model generate_${kind} uses on this machine (default = the account's)`,
      argumentHint: "[model id | default]",
      handler: (args: string, ctx: any) => runMediaModelCommand(kind, args, ctx?.ui),
    });
  }
}
