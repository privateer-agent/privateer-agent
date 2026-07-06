import React, { useState } from "react";
import { useStdout } from "ink";
import { App } from "./App.tsx";
import { Onboarding, type OnboardingResult } from "./Onboarding.tsx";
import { PrivateerLogin } from "./PrivateerLogin.tsx";
import { PROVIDER_META } from "../providers/catalog.ts";
import type { Config, ProviderName } from "../config/schema.ts";
import { saveGlobalConfig } from "../config/load.ts";
import { configuredProviders } from "../providers/resolve.ts";
import type { PrivateerUser } from "../auth/privateer.ts";
import type { SessionData } from "../memory/store.ts";

// Top-level state machine: shows the onboarding flow (provider selection + key entry)
// when needed, otherwise the main App. Onboarding can be re-entered from the app via
// the /keys command. Keeping config in state lets newly-saved keys take effect
// immediately without a restart.
export function Root({
  config: initialConfig,
  modelSpec: initialModel,
  cwd,
  resume,
  startInOnboarding,
}: {
  config: Config;
  modelSpec: string;
  cwd: string;
  resume?: SessionData | null;
  startInOnboarding: boolean;
}) {
  const [config, setConfig] = useState<Config>(initialConfig);
  const [modelSpec, setModelSpec] = useState(initialModel);
  const [onboarding, setOnboarding] = useState(startInOnboarding);
  // A provider picked in /model without credentials: onboarding opens with it
  // pre-checked so the user lands one enter away from its key prompt.
  const [setupProvider, setSetupProvider] = useState<ProviderName | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const { stdout } = useStdout();

  // The App's banner/transcript lives in Ink's <Static> region, which stays in the
  // terminal scrollback even after the component unmounts. Swapping screens (login,
  // onboarding) and back therefore stacks a second banner under the stale one. Wipe
  // screen + scrollback around every top-level swap so each view starts on a clean
  // page — same trick App uses when the terminal is resized.
  function swapScreen(update: () => void) {
    stdout?.write("\x1b[2J\x1b[3J\x1b[H"); // clear screen + scrollback, home cursor
    update();
  }

  // Providers that already have credentials — pre-checked when re-running onboarding.
  const configured = configuredProviders(config)
    .filter((p) => p.ready)
    .map((p) => p.name as ProviderName);

  function finish(result: OnboardingResult) {
    const next: Config = {
      ...config,
      defaultModel: result.defaultModel,
      providers: { ...config.providers, ...result.providers },
    };
    try {
      saveGlobalConfig(next);
    } catch {
      /* non-fatal: keys just won't persist to disk this run */
    }
    swapScreen(() => {
      setConfig(next);
      setModelSpec(result.defaultModel);
      setOnboarding(false);
      setSetupProvider(null);
    });
  }

  // After a successful account login, switch to the Privateer-billed model so the
  // session immediately uses the account (the provider is now "ready" because
  // credentials exist on disk). Add a providers.privateer entry so the App's
  // remount key changes and the new model resolves.
  function finishLogin(_user: PrivateerUser) {
    const spec = PROVIDER_META.privateer.defaultModel;
    const next: Config = {
      ...config,
      defaultModel: spec,
      providers: { ...config.providers, privateer: config.providers.privateer ?? {} },
    };
    try {
      saveGlobalConfig(next);
    } catch {
      /* non-fatal: model choice just won't persist this run */
    }
    swapScreen(() => {
      setConfig(next);
      setModelSpec(spec);
      setLoggingIn(false);
    });
  }

  if (loggingIn) {
    return (
      <PrivateerLogin
        onComplete={finishLogin}
        onCancel={() => swapScreen(() => setLoggingIn(false))}
      />
    );
  }

  if (onboarding) {
    return (
      <Onboarding
        initialSelected={setupProvider ? [...configured, setupProvider] : configured}
        zdrEnforced={Boolean(config.providers.openrouter?.enforceZdr)}
        onComplete={finish}
      />
    );
  }

  return (
    <App
      key={modelSpec + Object.keys(config.providers).join(",")}
      model={modelSpec}
      config={config}
      cwd={cwd}
      resume={resume}
      onLogin={() => swapScreen(() => { setSetupProvider(null); setOnboarding(true); })}
      onPrivateerLogin={() => swapScreen(() => setLoggingIn(true))}
      onSetupProvider={(name) => swapScreen(() => { setSetupProvider(name); setOnboarding(true); })}
    />
  );
}
