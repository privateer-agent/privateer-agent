import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { theme } from "./theme.ts";
import { WELCOME } from "./figures.ts";
import { runDeviceLogin, type DeviceCode, type PrivateerUser } from "../auth/privateer.ts";

// Device-authorization login screen. Shows the user_code to approve in the
// Privateer app, polls in the background, and resolves once approved. Esc
// cancels. Works the same for email and wallet accounts — all the signing
// happens in the app, never here.
export function PrivateerLogin({
  onComplete,
  onCancel,
}: {
  onComplete: (user: PrivateerUser) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    let cancelled = false;

    runDeviceLogin({
      onCode: (c) => !cancelled && setCode(c),
      onPoll: (state) => !cancelled && setSlow(state === "slow_down"),
      signal: ac.signal,
    })
      .then((user) => {
        if (!cancelled) onComplete(user);
      })
      .catch((err) => {
        if (cancelled) return;
        if (ac.signal.aborted) return; // user cancelled — handled by useInput
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((_input, key) => {
    if (key.escape || (key.return && error)) {
      abortRef.current?.abort();
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Text bold color={theme.accent}>
        {WELCOME} Sign in to your Privateer account
      </Text>
      <Text color={theme.dim}>
        Inference runs on your account and is billed to your subscription — no API key needed.
      </Text>

      {error ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.error ?? "red"}>{error}</Text>
          <Text color={theme.dim}>Press Esc or Enter to go back.</Text>
        </Box>
      ) : !code ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.dim}> Starting secure login…</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>1. Open the Privateer app (or web) where you're signed in.</Text>
          <Text color={theme.dim}>
            2. Go to <Text color={theme.accent}>Settings → Link a terminal</Text>
            {code.verification_uri ? (
              <Text color={theme.dim}>
                {" "}
                ({code.verification_uri})
              </Text>
            ) : null}
          </Text>
          <Text color={theme.dim}>3. Enter this code (or just open the link above):</Text>
          <Box marginY={1} borderStyle="round" borderColor={theme.accent} paddingX={2}>
            <Text bold color={theme.accent}>
              {code.user_code}
            </Text>
          </Box>
          {/* Deliberately NOT an animated spinner here: ink-spinner re-renders the
              whole frame ~12×/s, which wipes any text selection on the code above
              and makes it almost impossible to copy. A static line keeps the code
              selectable; this view only re-renders on a real state change. */}
          <Box>
            <Text color={theme.dim}>
              Waiting for approval…{slow ? " (slowing down)" : ""}  ·  Esc to cancel
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
