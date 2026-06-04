import React from "react";
import { Box, Text } from "ink";
import { VERSION } from "../version.ts";
import { theme } from "./theme.ts";
import { WELCOME } from "./figures.ts";

// Anchor motif rendered in ASCII — the Privateer mark (ring, stock, shank, flukes).
const ANCHOR = [
  "    .-.     ",
  "   (   )    ",
  "    '+'     ",
  "  ---+---   ",
  "     |      ",
  "     |      ",
  "  \\  |  /   ",
  "   \\_|_/    ",
  "  (_/ \\_)   ",
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
            {WELCOME} Welcome to Privateer
          </Text>
          <Text color={theme.dim}>v{VERSION} · bring your own model</Text>
          <Text> </Text>
          <Text>
            model <Text color={theme.accent}>{model}</Text>
          </Text>
          <Text color={theme.dim}>type a prompt · /help for commands</Text>
        </Box>
      </Box>
    </Box>
  );
}
