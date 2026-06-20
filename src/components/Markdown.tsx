import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.ts";

// A small, dependency-free markdown renderer for the terminal. It exists because
// assistant output is streamed in incrementally (App.tsx concatenates deltas), so a
// renderer that emits ANSI strings (marked-terminal et al.) would fight Ink's layout
// and reflow oddly on partial input. Instead we parse the text into Ink <Box>/<Text>
// nodes on every frame — the parse is a pure function of the current text, so half-
// finished markdown simply renders as plain-ish text until the closing marker arrives.
//
// Supported: ATX headings, fenced code blocks, blockquotes, unordered/ordered lists,
// horizontal rules, and inline bold/italic/code/links. Anything unrecognized falls
// through as a normal paragraph, so we never lose content.

// --- Inline formatting -----------------------------------------------------------

// One regex, alternation tried left-to-right at each position: code spans first so we
// never reparse markdown inside `code`, then bold before italic so `**x**` wins over
// `*x*`. Each construct forbids its own delimiter inside, which keeps it simple and
// means an unterminated marker (mid-stream) just renders literally until it closes.
const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)|(\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (m[1]) {
      // `inline code`
      nodes.push(
        <Text key={key} color={theme.accent}>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else if (m[2] || m[3]) {
      // **bold** or __bold__
      nodes.push(
        <Text key={key} bold>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (m[4] || m[5]) {
      // *italic* or _italic_
      nodes.push(
        <Text key={key} italic>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else {
      // [label](url) — show the label, underlined in the accent hue.
      const label = tok.slice(1, tok.indexOf("]"));
      nodes.push(
        <Text key={key} color={theme.accent} underline>
          {label}
        </Text>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// --- Block parsing ---------------------------------------------------------------

const FENCE_RE = /^\s*```/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^>\s?(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)\.\s+(.*)$/;

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let bi = 0;

  const flushPara = () => {
    if (para.length === 0) return;
    const joined = para.join("\n");
    blocks.push(
      <Text key={`p-${bi++}`}>{renderInline(joined, `p-${bi}`)}</Text>,
    );
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block: accumulate verbatim until the closing fence (or EOF, so a
    // still-streaming block renders instead of swallowing the rest of the message).
    if (FENCE_RE.test(line)) {
      flushPara();
      const code: string[] = [];
      i++;
      for (; i < lines.length && !FENCE_RE.test(lines[i]); i++) code.push(lines[i]);
      blocks.push(
        <Box key={`code-${bi++}`} flexDirection="column" paddingLeft={2}>
          {(code.length ? code : [""]).map((c, j) => (
            <Text key={j} color={theme.accent} dimColor>
              {c || " "}
            </Text>
          ))}
        </Box>,
      );
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      continue;
    }

    const hr = HR_RE.test(line);
    if (hr) {
      flushPara();
      blocks.push(
        <Text key={`hr-${bi++}`} color={theme.dim} dimColor>
          {"─".repeat(40)}
        </Text>,
      );
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      flushPara();
      blocks.push(
        <Text key={`h-${bi++}`} color={theme.accent} bold>
          {renderInline(heading[2], `h-${bi}`)}
        </Text>,
      );
      continue;
    }

    const quote = line.match(QUOTE_RE);
    if (quote) {
      flushPara();
      blocks.push(
        <Box key={`q-${bi++}`}>
          <Text color={theme.dim}>{"▏ "}</Text>
          <Box flexGrow={1}>
            <Text color={theme.dim} dimColor>
              {renderInline(quote[1], `q-${bi}`)}
            </Text>
          </Box>
        </Box>,
      );
      continue;
    }

    const ul = line.match(UL_RE);
    const ol = line.match(OL_RE);
    if (ul || ol) {
      flushPara();
      const indent = (ul ? ul[1] : ol![1]).length;
      const marker = ul ? "•" : `${ol![2]}.`;
      const content = ul ? ul[2] : ol![3];
      blocks.push(
        <Box key={`li-${bi++}`} paddingLeft={indent}>
          <Text color={theme.accent}>{marker} </Text>
          <Box flexGrow={1}>
            <Text>{renderInline(content, `li-${bi}`)}</Text>
          </Box>
        </Box>,
      );
      continue;
    }

    para.push(line);
  }
  flushPara();

  return <Box flexDirection="column">{blocks}</Box>;
}
