import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import type { Config, ProviderName } from "../config/schema.ts";
import { configuredProviders, privateerChannel } from "../providers/resolve.ts";
import { PROVIDER_META } from "../providers/catalog.ts";
import { listModels, zdrPosture, type ModelInfo } from "../providers/models.ts";
import { theme, POSTURE_COLOR } from "./theme.ts";
import { SHIELD } from "./figures.ts";
import { useZdrAccount, type ZdrAccountState } from "./useZdrShield.ts";

const PAGE = 8; // visible rows in the scrolling model list

// A two-stage picker: choose a configured provider, then choose one of the models it
// actually offers (fetched live with the user's key). Returns a "provider:model" spec.
// Reused by the /model command and the onboarding flow. Esc cancels (if onCancel given).
export function ModelPicker({
  config,
  providers,
  onSelect,
  onCancel,
}: {
  config: Config;
  // Restrict the provider stage to these names; defaults to all ready providers.
  providers?: ProviderName[];
  onSelect: (spec: string) => void;
  onCancel?: () => void;
}) {
  const ready = useMemo(() => {
    const offered = providers ?? configuredProviders(config).filter((p) => p.ready).map((p) => p.name);
    return offered as ProviderName[];
  }, [config, providers]);

  const [provider, setProvider] = useState<ProviderName | null>(ready.length === 1 ? ready[0] : null);

  if (ready.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.error}>No providers configured. Run /login to add an API key.</Text>
      </Box>
    );
  }

  if (provider === null) {
    return <ProviderStage providers={ready} onPick={setProvider} onCancel={onCancel} />;
  }

  return (
    <ModelStage
      provider={provider}
      config={config}
      onSelect={(id) => onSelect(`${provider}:${id}`)}
      onBack={ready.length > 1 ? () => setProvider(null) : undefined}
      onCancel={onCancel}
    />
  );
}

function ProviderStage({
  providers,
  onPick,
  onCancel,
}: {
  providers: ProviderName[];
  onPick: (name: ProviderName) => void;
  onCancel?: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  useInput((input, key) => {
    if (key.upArrow || input === "k") setCursor((c) => (c - 1 + providers.length) % providers.length);
    else if (key.downArrow || input === "j") setCursor((c) => (c + 1) % providers.length);
    else if (key.return) onPick(providers[cursor]);
    else if (key.escape) onCancel?.();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.dim}>
        Pick a provider — <Text color={theme.accent}>↑↓</Text> move,{" "}
        <Text color={theme.accent}>enter</Text> select{onCancel ? ", esc cancel" : ""}.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {providers.map((name, i) => (
          <Text key={name} color={i === cursor ? theme.accent : undefined}>
            {i === cursor ? "❯ " : "  "}
            {PROVIDER_META[name].label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function ModelStage({
  provider,
  config,
  onSelect,
  onBack,
  onCancel,
}: {
  provider: ProviderName;
  config: Config;
  onSelect: (id: string) => void;
  onBack?: () => void;
  onCancel?: () => void;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  // OpenRouter only: the account's ZDR snapshot, used to color a per-model badge.
  const zdrAccount = useZdrAccount(provider, config);
  const zdrEnforced = Boolean(config.providers.openrouter?.enforceZdr);
  // Privateer: every model carries a privacy channel (TEE or ZDR) derived from its
  // id, surfaced as a per-row badge so the channel is visible before you pick.
  const isPrivateer = provider === "privateer";

  useEffect(() => {
    let alive = true;
    setModels(null);
    setError(null);
    listModels(provider, config.providers[provider] ?? {})
      .then((m) => alive && setModels(m))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [provider]);

  const filtered = useMemo(() => {
    if (!models) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.label?.toLowerCase().includes(q) ?? false),
    );
  }, [models, filter]);

  // Keep the cursor in range as the filter narrows the list.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useInput((_input, key) => {
    if (key.escape) {
      onBack ? onBack() : onCancel?.();
      return;
    }
    if (!filtered.length) return;
    if (key.upArrow) setCursor((c) => (c - 1 + filtered.length) % filtered.length);
    else if (key.downArrow) setCursor((c) => (c + 1) % filtered.length);
    else if (key.return) onSelect(filtered[cursor].id);
  });

  const label = PROVIDER_META[provider].label;

  if (error !== null) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.error}>Couldn't fetch {label} models: {error}</Text>
        <Text color={theme.dim}>
          Check the API key with /login, or set a model directly: /model {provider}:&lt;id&gt;.
          {onBack ? " Esc to go back." : ""}
        </Text>
      </Box>
    );
  }

  if (models === null) {
    return (
      <Box paddingX={1} gap={1}>
        <Text color={theme.accent}>
          <Spinner type="dots" />
        </Text>
        <Text color={theme.dim}>Fetching {label} models…</Text>
      </Box>
    );
  }

  // Window the list around the cursor so long catalogs (OpenRouter has hundreds) scroll.
  const start = Math.max(0, Math.min(cursor - Math.floor(PAGE / 2), Math.max(0, filtered.length - PAGE)));
  const view = filtered.slice(start, start + PAGE);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.dim}>
        {label} — <Text color={theme.accent}>{filtered.length}</Text> models. Type to filter,{" "}
        <Text color={theme.accent}>↑↓</Text> move, <Text color={theme.accent}>enter</Text> select
        {onBack ? ", esc back" : onCancel ? ", esc cancel" : ""}.
      </Text>
      {isPrivateer ? <PrivateerLegend /> : <ZdrLegend state={zdrAccount} enforced={zdrEnforced} />}
      <Box marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent}>{"/ "}</Text>
        <TextInput value={filter} onChange={setFilter} placeholder="filter models…" />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? (
          <Text color={theme.dim}>No models match "{filter}".</Text>
        ) : (
          view.map((m, i) => {
            const idx = start + i;
            const active = idx === cursor;
            // Privateer: label the privacy channel (TEE/ZDR) from the model id.
            // OpenRouter: color a bare shield by the account's per-model ZDR posture.
            const channel = isPrivateer ? privateerChannel(m.id) : null;
            const posture =
              !isPrivateer && zdrAccount.kind === "ready"
                ? zdrPosture(m.id, zdrAccount.account, zdrEnforced)
                : null;
            return (
              <Text key={m.id} color={active ? theme.accent : undefined}>
                {active ? "❯ " : "  "}
                {channel ? (
                  <Text color={theme.success}>{`${SHIELD} ${channel === "tee" ? "TEE" : "ZDR"}  `}</Text>
                ) : posture ? (
                  <Text color={POSTURE_COLOR[posture]}>{`${SHIELD} `}</Text>
                ) : null}
                {m.id}
                {m.label && m.label !== m.id ? <Text color={theme.dim}> — {m.label}</Text> : null}
              </Text>
            );
          })
        )}
      </Box>
    </Box>
  );
}

// One-line key for the per-model ⛉ badge, shown only for OpenRouter. While the
// account snapshot loads we say so; if it can't be fetched (no key / error) we stay
// silent rather than imply a verdict — the rows simply render without a badge.
// With enforcement off, ZDR-capable models read yellow; /zdr flips it on so they
// go green (and non-ZDR models become red/unusable).
// One-line key for the Privateer ⛉ TEE/ZDR badges. Both channels keep your prompts
// private — TEE runs the model in a confidential enclave (attestable via /verify),
// ZDR routes through zero-data-retention endpoints — so both render green.
function PrivateerLegend() {
  return (
    <Text color={theme.dim}>
      <Text color={POSTURE_COLOR.green}>{`${SHIELD} TEE`}</Text> confidential enclave (attestable){"  "}
      <Text color={POSTURE_COLOR.green}>{`${SHIELD} ZDR`}</Text> zero data retention
    </Text>
  );
}

function ZdrLegend({ state, enforced }: { state: ZdrAccountState; enforced: boolean }) {
  if (state.kind === "idle" || state.kind === "error") return null;
  if (state.kind === "loading") {
    return <Text color={theme.dim}>{`${SHIELD} ZDR — checking your account…`}</Text>;
  }
  return (
    <Text color={theme.dim}>
      {enforced ? (
        <>
          <Text color={POSTURE_COLOR.green}>{SHIELD}</Text> ZDR enforced{"  "}
          <Text color={POSTURE_COLOR.red}>{SHIELD}</Text> no ZDR endpoint — unusable
          {"  "}(/zdr to relax)
        </>
      ) : (
        <>
          <Text color={POSTURE_COLOR.yellow}>{SHIELD}</Text> ZDR available{"  "}
          <Text color={POSTURE_COLOR.red}>{SHIELD}</Text> data retained{"  "}
          (/zdr to enforce → green)
        </>
      )}
    </Text>
  );
}
