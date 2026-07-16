// The Privateer `/models` picker — a searchable model selector that puts the
// PRIVACY POSTURE of every model on screen. Pi's built-in `/model` picker (which
// this shadows via the redirect patch in patches/@earendil-works+pi-coding-agent)
// shows only `id [provider]`; it has no hook for a privacy shield and can't be
// overridden from an extension (its command name is a reserved builtin, dispatched
// before extension commands). So we ship our OWN picker through `ctx.ui.custom`,
// which renders a full pi-tui component: fuzzy search + a per-row shield (⛉ TEE /
// ◈ ZDR / · standard) + tier grouping + a legend, ranked strongest-privacy-first.
//
// Honest-labeling contract (pi-privacy posture/tiers.ts): a TEE row is only a
// *claim* (tee-unverified, yellow) until a live attestation confirms it
// (tee-verified, green). The picker seeds each row with the server's baseline tier
// (GET /api/models `privacy.tier`, via account.ts) and then attests the TEE-capable
// rows in the background, upgrading the shield in place. ZDR-enforced rows are never
// downgraded by attestation — we only attest rows that claim a TEE.

import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { TIERS, tierRank, type PrivacyTier } from "pi-privacy";
import { verifyModelPosture } from "pi-privacy";
import {
  accountBaselineTier,
  accountCatalogLoaded,
  accountPosture,
  fetchAccountCatalog,
} from "../src/providers/account.ts";

// A minimal view of Pi's theme (passed to the ui.custom factory) — enough to color
// text without pulling Pi's internal theme types into an extension.
interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

// A pi-tui TUI handle (the first arg the ui.custom factory receives). We only use
// requestRender; keep the surface tiny so this doesn't couple to Pi internals.
interface TuiLike {
  requestRender(): void;
}

interface ModelLike {
  provider: string;
  id: string;
  name?: string;
}

interface Row {
  provider: string;
  id: string;
  name: string;
  model: ModelLike;
  tier: PrivacyTier;
  // true once a live attestation has resolved this row (so we don't re-attest).
  attested?: boolean;
}

// posture bucket → theme color name (Pi's palette) for the shield glyph.
const POSTURE_COLOR: Record<string, string> = {
  green: "success",
  yellow: "warning",
  red: "error",
  neutral: "muted",
};

// The shield/marker glyph per tier family. TEE → shield; ZDR → diamond; local →
// house; standard → dot. Color comes from the tier's posture bucket, so verified
// (green) and merely-claimed (yellow) read differently at a glance — the same
// distinction the status-bar badge (privateer-posture.ts) draws.
function glyphFor(tier: PrivacyTier): string {
  if (tier === "tee-verified" || tier === "tee-unverified") return "⛉";
  if (tier === "local") return "⌂";
  if (tier === "zdr-enforced" || tier === "zdr-policy") return "◈";
  return "·";
}

function shield(theme: ThemeLike, tier: PrivacyTier): string {
  const info = TIERS[tier];
  const color = POSTURE_COLOR[info.posture] ?? "muted";
  return theme.fg(color, glyphFor(tier));
}

// Server/prefix baseline tier for a provider+model, before any live attestation.
function baselineTier(provider: string, id: string): PrivacyTier {
  if (provider === "privateer") {
    return (
      accountBaselineTier(id) ??
      (id.startsWith("near/") || id.startsWith("tinfoil/") ? "tee-unverified" : "standard")
    );
  }
  if (provider === "tinfoil" || provider === "nearai") return "tee-unverified";
  if (provider === "ollama") return "local";
  return "standard";
}

// A row claims a TEE and is therefore worth attesting live (to go green — or to
// honestly drop to standard if the attestation fails). ZDR/standard rows are left
// on their server baseline; attesting them would only ever weaken an honest label.
function isTeeCandidate(row: Row): boolean {
  if (row.tier !== "tee-verified" && row.tier !== "tee-unverified") return false;
  if (row.provider === "privateer") return row.id.startsWith("near/") || row.id.startsWith("tinfoil/");
  return row.provider === "tinfoil" || row.provider === "nearai";
}

// Run the live attestation for one TEE-candidate row. privateer/* goes through the
// account server-proxy path (accountPosture); other providers use pi-privacy's
// direct client attestation. Returns undefined on any failure (keep the baseline).
async function attestRow(row: Row): Promise<PrivacyTier | undefined> {
  try {
    if (row.provider === "privateer") {
      const res = await accountPosture(row.id);
      return res.tier;
    }
    const apiKey =
      row.provider === "nearai"
        ? process.env.NEARAI_API_KEY ?? process.env.NEAR_AI_API_KEY
        : undefined;
    const res = await verifyModelPosture(row.provider, row.id, { apiKey });
    return res.tier;
  } catch {
    return undefined;
  }
}

// The search text a row is matched against — id, provider, name, and the tier label
// so a user can type "tee" or "zdr" to filter by posture.
function searchText(row: Row): string {
  return `${row.provider} ${row.provider}/${row.id} ${row.id} ${row.name} ${TIERS[row.tier].label}`;
}

// Strongest-privacy-first, then provider, then id — so the safest options surface at
// the top of an unfiltered list.
function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const r = tierRank(a.tier) - tierRank(b.tier);
    if (r !== 0) return r;
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });
}

const MAX_VISIBLE = 12;

class ModelsPicker extends Container {
  private tui: TuiLike;
  private theme: ThemeLike;
  private rows: Row[];
  private filtered: Row[];
  private selectedIndex = 0;
  private searchInput: Input;
  private listContainer: Container;
  private legendText: Text;
  private blurbText: Text;
  private currentId: string | undefined;
  private onSelect: (row: Row) => void;
  private onCancel: () => void;
  private _focused = false;

  constructor(opts: {
    tui: TuiLike;
    theme: ThemeLike;
    rows: Row[];
    current: ModelLike | undefined;
    onSelect: (row: Row) => void;
    onCancel: () => void;
  }) {
    super();
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.rows = sortRows(opts.rows);
    this.filtered = this.rows;
    this.currentId = opts.current ? `${opts.current.provider}/${opts.current.id}` : undefined;
    this.onSelect = opts.onSelect;
    this.onCancel = opts.onCancel;

    const t = this.theme;
    this.addChild(new Text(t.fg("accent", t.bold("Select a model")), 1, 0));
    this.legendText = new Text(this.legend(), 1, 0);
    this.addChild(this.legendText);
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => {
      const row = this.filtered[this.selectedIndex];
      if (row) this.onSelect(row);
    };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    this.blurbText = new Text("", 1, 0);
    this.addChild(this.blurbText);
    this.addChild(
      new Text(
        t.fg("muted", "↑↓ navigate   ⏎ select   type to search   esc cancel"),
        1,
        0,
      ),
    );

    // Keep selection on the current model if it's in the list.
    const cur = this.rows.findIndex((r) => `${r.provider}/${r.id}` === this.currentId);
    if (cur >= 0) this.selectedIndex = cur;

    this.updateList();
    void this.attestTeeRows();
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.searchInput.focused = v;
  }

  private legend(): string {
    const t = this.theme;
    return (
      `${shield(t, "tee-verified")} ${t.fg("muted", "TEE")}   ` +
      `${shield(t, "zdr-enforced")} ${t.fg("muted", "ZDR")}   ` +
      `${shield(t, "standard")} ${t.fg("muted", "Standard")}   ` +
      t.fg("muted", "— green = verified/enforced, yellow = claimed")
    );
  }

  // Fire attestation for every TEE-candidate row in parallel; upgrade each shield in
  // place as its result lands. Cheap in practice (the enabled catalog is mostly
  // ZDR/standard), and never blocks the picker — the baseline renders immediately.
  private async attestTeeRows(): Promise<void> {
    const candidates = this.rows.filter((r) => isTeeCandidate(r) && !r.attested);
    if (!candidates.length) return;
    await Promise.allSettled(
      candidates.map(async (row) => {
        const tier = await attestRow(row);
        row.attested = true;
        if (tier && tier !== row.tier) {
          row.tier = tier;
        }
      }),
    );
    // Re-sort (a newly-verified TEE may move up) and re-render once, preserving the
    // highlighted model across the reshuffle.
    const selected = this.filtered[this.selectedIndex];
    this.rows = sortRows(this.rows);
    this.applyFilter(this.searchInput.getValue(), selected);
    this.legendText.setText(this.legend());
    this.tui.requestRender();
  }

  private applyFilter(query: string, keep?: Row): void {
    this.filtered = query
      ? fuzzyFilter(this.rows, query, (r: Row) => searchText(r))
      : this.rows;
    if (keep) {
      const i = this.filtered.findIndex((r) => r.provider === keep.provider && r.id === keep.id);
      this.selectedIndex = i >= 0 ? i : 0;
    } else {
      this.selectedIndex = 0;
    }
    this.updateList();
  }

  private updateList(): void {
    const t = this.theme;
    this.listContainer.clear();
    if (this.filtered.length === 0) {
      this.listContainer.addChild(new Text(t.fg("muted", "  No matching models"), 1, 0));
      this.blurbText.setText("");
      return;
    }
    if (this.selectedIndex >= this.filtered.length) this.selectedIndex = this.filtered.length - 1;

    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filtered.length - MAX_VISIBLE),
    );
    const end = Math.min(start + MAX_VISIBLE, this.filtered.length);
    for (let i = start; i < end; i++) {
      const row = this.filtered[i];
      const isSel = i === this.selectedIndex;
      const isCur = `${row.provider}/${row.id}` === this.currentId;
      const mark = shield(t, row.tier);
      const label = TIERS[row.tier].label;
      const idText = isSel ? t.fg("accent", row.id) : t.fg("text", row.id);
      const prov = t.fg("muted", `[${row.provider}]`);
      const tierText = t.fg(POSTURE_COLOR[TIERS[row.tier].posture] ?? "muted", label);
      const check = isCur ? t.fg("success", " ✓") : "";
      const prefix = isSel ? t.fg("accent", "→ ") : "  ";
      this.listContainer.addChild(
        new Text(`${prefix}${mark} ${idText} ${prov} ${tierText}${check}`, 1, 0),
      );
    }
    if (start > 0 || end < this.filtered.length) {
      this.listContainer.addChild(
        new Text(t.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 1, 0),
      );
    }
    // Honest one-liner for the highlighted model — states the LIMIT of the claim.
    const sel = this.filtered[this.selectedIndex];
    if (sel) this.blurbText.setText(t.fg("muted", `  ${TIERS[sel.tier].blurb}`));
  }

  // Seed the search box (from `/models <query>`) and filter to match.
  setQuery(q: string): void {
    this.searchInput.setValue(q);
    this.applyFilter(q);
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.up")) {
      if (!this.filtered.length) return;
      this.selectedIndex =
        this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
      this.updateList();
    } else if (kb.matches(keyData, "tui.select.down")) {
      if (!this.filtered.length) return;
      this.selectedIndex =
        this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      const row = this.filtered[this.selectedIndex];
      if (row) this.onSelect(row);
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      this.onCancel();
    } else {
      // Everything else edits the search box, then re-filters.
      this.searchInput.handleInput(keyData);
      this.applyFilter(this.searchInput.getValue());
    }
  }
}

// The extension entrypoint. Registers `/models`; the redirect patch also routes
// `/model` here so the shielded picker is the single model surface.
export default function privateerModels(pi: {
  registerCommand?: (name: string, opts: unknown) => void;
  setModel?: (model: ModelLike) => Promise<boolean> | boolean;
}): void {
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("models", {
    description: "Pick a model with its privacy posture (TEE / ZDR / standard) — searchable",
    argumentHint: "[search]",
    handler: async (args: string, ctx: any): Promise<void> => {
      const ui = ctx?.ui;
      if (!ui?.custom) {
        ctx?.ui?.notify?.("The model picker needs an interactive terminal.", "warning");
        return;
      }
      const registry = ctx.modelRegistry;
      // Refresh so a just-fetched account catalog / models.json edit is reflected.
      try {
        registry?.refresh?.();
      } catch {
        /* non-fatal */
      }
      // Make sure the account baseline tiers are loaded (first-open may race the
      // provider's background fetch). Best-effort; falls back to prefix heuristics.
      if (!accountCatalogLoaded()) {
        try {
          await fetchAccountCatalog();
        } catch {
          /* keep heuristics */
        }
      }

      let available: ModelLike[] = [];
      try {
        available = (await registry.getAvailable()) as ModelLike[];
      } catch (e) {
        ui.notify?.(`Couldn't list models: ${(e as Error).message}`, "error");
        return;
      }
      if (!available.length) {
        ui.notify?.("No models available. Use /login to add a provider.", "warning");
        return;
      }

      const rows: Row[] = available.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name ?? m.id,
        model: m,
        tier: baselineTier(m.provider, m.id),
      }));

      const initialQuery = String(args ?? "").trim();
      const chosen: Row | undefined = await ui.custom(
        (tui: TuiLike, theme: ThemeLike, _kb: unknown, close: (result?: Row) => void) => {
          const picker = new ModelsPicker({
            tui,
            theme,
            rows,
            current: ctx.model,
            onSelect: (row) => close(row),
            onCancel: () => close(undefined),
          });
          if (initialQuery) picker.setQuery(initialQuery);
          return picker;
        },
      );

      if (!chosen) return;
      try {
        const ok = await pi.setModel!(chosen.model);
        if (ok === false) {
          ui.notify?.(`No API key for ${chosen.provider}/${chosen.id}.`, "warning");
          return;
        }
        ui.notify?.(
          `Model: ${chosen.provider}/${chosen.id}  ·  ${TIERS[chosen.tier].label}`,
          "info",
        );
      } catch (e) {
        ui.notify?.(`Couldn't switch model: ${(e as Error).message}`, "error");
      }
    },
  });
}
