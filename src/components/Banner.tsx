import React from "react";
import os from "node:os";
import { Box, Text } from "ink";
import { VERSION } from "../version.ts";
import { theme } from "./theme.ts";
import { WELCOME } from "./figures.ts";

// Collapse the user's home directory to ~ for a compact path display.
function shortenPath(cwd: string): string {
  const home = os.homedir();
  return cwd === home || cwd.startsWith(home + "/")
    ? "~" + cwd.slice(home.length)
    : cwd;
}

// Anchor motif rendered in ASCII — the Privateer mark (ring, stock, shank, flukes).
const ANCHOR = [
  "    .-.    ",
  "   |___|   ",
  "   | + |   ",
  "   '-+-'   ",
  "  ---|---  ",
  " _   |   _ ",
  "  \\  |  /  ",
  "   \\_|_/   ",
];

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
          <Text color={theme.dim}>bring your own model · v{VERSION}</Text>
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
