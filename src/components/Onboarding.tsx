import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Config, ProviderName, ProviderConfig } from "../config/schema.ts";
import { PROVIDER_LIST, PROVIDER_META, type ProviderMeta } from "../providers/catalog.ts";
import { providerReady } from "../providers/resolve.ts";
import { ModelPicker, PrivacyBadge } from "./ModelPicker.tsx";
import { theme } from "./theme.ts";
import { WELCOME } from "./figures.ts";

// Which of the just-entered providers are actually usable (have a key, a base URL
// for the custom endpoint, or are keyless) — same rule the picker/doctor use.
function readyProviders(creds: Partial<Record<ProviderName, ProviderConfig>>): ProviderName[] {
  return (Object.keys(creds) as ProviderName[]).filter((name) =>
    providerReady(name, creds[name] ?? {}),
  );
}

export interface OnboardingResult {
  providers: Partial<Record<ProviderName, ProviderConfig>>;
  defaultModel: string;
}

// Step 1 — multi-select the providers to configure. Arrows/jk move, space toggles,
// enter confirms (needs at least one).
function SelectStep({
  initial,
  zdrEnforced,
  onConfirm,
}: {
  initial: Set<ProviderName>;
  zdrEnforced: boolean;
  onConfirm: (selected: ProviderMeta[]) => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<ProviderName>>(new Set(initial));

  useInput((input, key) => {
    if (key.upArrow || input === "k") setCursor((c) => (c - 1 + PROVIDER_LIST.length) % PROVIDER_LIST.length);
    else if (key.downArrow || input === "j") setCursor((c) => (c + 1) % PROVIDER_LIST.length);
    else if (input === " ") {
      const name = PROVIDER_LIST[cursor].name;
      setSelected((s) => {
        const next = new Set(s);
        next.has(name) ? next.delete(name) : next.add(name);
        return next;
      });
    } else if (key.return && selected.size > 0) {
      onConfirm(PROVIDER_LIST.filter((p) => selected.has(p.name)));
    }
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.dim}>
        Select the providers you want to use — <Text color={theme.accent}>space</Text> to toggle,{" "}
        <Text color={theme.accent}>enter</Text> to continue.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {PROVIDER_LIST.map((p, i) => {
          const on = selected.has(p.name);
          const active = i === cursor;
          return (
            <Text key={p.name} color={active ? theme.accent : undefined}>
              {active ? "❯ " : "  "}
              {on ? "◉" : "○"} {p.label.padEnd(16)}
              <PrivacyBadge meta={p} zdrEnforced={zdrEnforced} />
              <Text color={theme.dim}> {p.requiresKey ? `key: ${p.keyHint}` : p.keyHint}</Text>
            </Text>
          );
        })}
      </Box>
      {selected.size === 0 && (
        <Text color={theme.dim}>{"\n"}Select at least one provider to continue.</Text>
      )}
    </Box>
  );
}

// Step 2 — walk the chosen providers one at a time, collecting a masked API key (or a
// base URL for keyless/local providers). Empty key = skip that provider's credential.
// The custom endpoint asks two questions: the base URL (required — skipping it skips
// the provider) and then an API key (optional — many local servers don't need one).
function KeyStep({
  providers,
  onDone,
}: {
  providers: ProviderMeta[];
  onDone: (creds: Partial<Record<ProviderName, ProviderConfig>>) => void;
}) {
  const [index, setIndex] = useState(0);
  const [value, setValue] = useState("");
  const [creds, setCreds] = useState<Partial<Record<ProviderName, ProviderConfig>>>({});
  // The custom provider's URL, held between its two prompts.
  const [pendingURL, setPendingURL] = useState<string | null>(null);
  const meta = providers[index];
  const isCustom = meta.name === "custom";
  const askingURL = isCustom && pendingURL === null;

  function advance(entry: ProviderConfig) {
    const nextCreds = { ...creds, [meta.name]: entry };
    setCreds(nextCreds);
    setPendingURL(null);
    setValue("");
    if (index + 1 < providers.length) setIndex(index + 1);
    else onDone(nextCreds);
  }

  function submit(raw: string) {
    const v = raw.trim();
    if (askingURL) {
      // No URL → skip the provider (an empty entry keeps it listed but not ready).
      if (!v) return advance({});
      setPendingURL(v);
      setValue("");
      return;
    }
    if (isCustom) return advance({ baseURL: pendingURL!, ...(v ? { apiKey: v } : {}) });
    advance(meta.requiresKey ? (v ? { apiKey: v } : {}) : { baseURL: v || meta.baseURLDefault });
  }

  const prompt = askingURL
    ? `Base URL of your OpenAI-compatible endpoint (${meta.keyHint}). Enter to skip.`
    : isCustom
      ? `API key for ${pendingURL} — Enter to skip if the endpoint doesn't need one.`
      : meta.requiresKey
        ? `Paste your API key (${meta.keyHint}). Enter to skip.`
        : `Base URL for ${meta.label}. Enter to use the default.`;
  const masked = isCustom ? !askingURL : meta.requiresKey;

  return (
    <Box flexDirection="column">
      <Text color={theme.dim}>
        Step {index + 1} of {providers.length} —{" "}
        <Text color={theme.accent}>{meta.label}</Text>
      </Text>
      <Text color={theme.dim}>{prompt}</Text>
      <Box marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent}>{"> "}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          mask={masked ? "*" : undefined}
          placeholder={masked ? "sk-…" : meta.baseURLDefault}
        />
      </Box>
    </Box>
  );
}

// Step 3 — pick the default model from the providers just configured, with the model
// list fetched live using the entered keys. Esc (or a fetch failure) falls back to the
// provider's catalog default, so onboarding always completes.
function ModelStep({
  creds,
  ready,
  fallback,
  onDone,
}: {
  creds: Partial<Record<ProviderName, ProviderConfig>>;
  ready: ProviderName[];
  fallback: string;
  onDone: (spec: string) => void;
}) {
  // ModelPicker only reads config.providers; a synthetic config is enough here.
  const synthetic = { providers: creds } as Config;
  return (
    <Box flexDirection="column">
      <Text color={theme.dim}>Choose your default model — you can change it later with /model.</Text>
      <Box marginTop={1}>
        <ModelPicker
          config={synthetic}
          providers={ready}
          onSelect={onDone}
          onCancel={() => onDone(fallback)}
        />
      </Box>
    </Box>
  );
}

export function Onboarding({
  initialSelected = [],
  zdrEnforced = false,
  onComplete,
}: {
  initialSelected?: ProviderName[];
  // Whether OpenRouter ZDR enforcement (/zdr) is already on — colors its ⛉ badge.
  zdrEnforced?: boolean;
  onComplete: (result: OnboardingResult) => void;
}) {
  const [chosen, setChosen] = useState<ProviderMeta[] | null>(null);
  const [creds, setCreds] = useState<Partial<Record<ProviderName, ProviderConfig>> | null>(null);

  function onKeysDone(entered: Partial<Record<ProviderName, ProviderConfig>>) {
    const ready = readyProviders(entered);
    // No usable credentials (every key skipped): nothing to pick from — finish on the
    // chosen provider's catalog default rather than showing an empty picker.
    if (ready.length === 0) {
      onComplete({ providers: entered, defaultModel: chosen![0].defaultModel });
      return;
    }
    setCreds(entered);
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Text bold color={theme.accent}>
        {WELCOME} Welcome to Privateer — let's set up your providers
      </Text>
      <Text color={theme.dim}>Bring your own keys. They're saved to ~/.privateer/config.json.</Text>
      <Box marginTop={1}>
        {chosen === null ? (
          <SelectStep initial={new Set(initialSelected)} zdrEnforced={zdrEnforced} onConfirm={setChosen} />
        ) : creds === null ? (
          <KeyStep providers={chosen} onDone={onKeysDone} />
        ) : (
          <ModelStep
            creds={creds}
            ready={readyProviders(creds)}
            fallback={PROVIDER_META[readyProviders(creds)[0]].defaultModel}
            onDone={(spec) => onComplete({ providers: creds, defaultModel: spec })}
          />
        )}
      </Box>
    </Box>
  );
}
