import React from "react";
import os from "node:os";
import { Box, Text } from "ink";
import { VERSION } from "../version.ts";
import { theme } from "./theme.ts";
import { WELCOME } from "./figures.ts";
import { currentUser } from "../auth/privateer.ts";
import { parseModelSpec } from "../providers/resolve.ts";

// Collapse the user's home directory to ~ for a compact path display.
function shortenPath(cwd: string): string {
  const home = os.homedir();
  return cwd === home || cwd.startsWith(home + "/")
    ? "~" + cwd.slice(home.length)
    : cwd;
}

// The Privateer account this terminal is signed into: email accounts show the
// email; wallet accounts (no email) show the first few characters of the Solana
// public key. Returns null when running unauthenticated (BYO key, no account).
function accountLabel(): string | null {
  const user = currentUser();
  if (!user) return null;
  if (user.email) return user.email;
  if (user.solanaPublicKey) return user.solanaPublicKey.slice(0, 6) + "…";
  return null;
}

// Anchor motif rendered in ASCII — the Privateer mark (ring, stock, shank, flukes).
const ANCHOR = [
  "    .-.    ",
  "    '_'   ",
  "   --|--  ",
  "     |    ",
  "  \\  |  /  ",
  "   \\_|_/   ",
];

// The account line under the tagline, one of three states:
//  - signed in            → "connected as <account>"
//  - signed out, but the active model bills to a Privateer account → the model
//    can't run until they sign in, so say so plainly (warning, not buried)
//  - signed out on their own key → everything works; a quiet dim tease that an
//    account adds hosted models and remote access, nothing more insistent
function AccountLine({ model }: { model: string }) {
  const account = accountLabel();
  if (account)
    return (
      <Text color={theme.dim}>
        connected as <Text color={theme.accent}>{account}</Text>
      </Text>
    );
  let provider = "";
  try {
    provider = parseModelSpec(model).provider;
  } catch {
    /* malformed spec — fall through to the BYO-key line */
  }
  if (provider === "privateer")
    return <Text color={theme.warning}>not signed in · run /login to use this model</Text>;
  return <Text color={theme.dim}>on your own key · /login adds account models & remote access</Text>;
}

export function Banner({ model }: { model: string }) {
  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
        flexDirection="row"
        gap={2}
      >
        <Box flexDirection="column">
          {ANCHOR.map((line, i) => (
            <Text key={i} color={theme.accent}>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" justifyContent="center">
          <Text bold color={theme.accent}>
            {WELCOME} PRIVATEER
          </Text>
          <Text color={theme.dim}>
            bring your own model or connect to Privateer · v{VERSION}
          </Text>
          <AccountLine model={model} />
          <Text> </Text>
          <Text>
            model <Text color={theme.accent}>{model}</Text>
          </Text>
          <Text color={theme.dim}>type a prompt · /help for commands</Text>
          <Text color={theme.accent}>{shortenPath(process.cwd())}</Text>
        </Box>
      </Box>
    </Box>
  );
}
