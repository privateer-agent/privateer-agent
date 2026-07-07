// Secret redaction for anything that leaves the process as text — error
// messages, exported transcripts, future telemetry. Provider SDKs sometimes
// echo the request (auth header included) inside an error, so we scrub before
// any of that reaches the UI or disk.

const PLACEHOLDER = "«redacted»";

// Common API-key shapes, masked even when we don't have the exact value on hand:
// OpenAI `sk-…`, Anthropic `sk-ant-…`, OpenRouter `sk-or-v1-…`, Google `AIza…`,
// xAI `xai-…`, Groq `gsk_…`, Z.ai/Zhipu `<32 hex>.<suffix>`, Cerebras `csk-…`,
// Venice `vapi_…`, Fireworks `fw_…`, and bare
// "Bearer <token>" / "x-api-key: <token>" / "x-goog-api-key: <token>" header
// fragments. (Mistral and Together keys are prefix-less, so they rely on
// exact-value masking and the header patterns.)
const KEY_PATTERNS: RegExp[] = [
  /\bsk-(ant|or|proj|live|test)?-?[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bxai-[A-Za-z0-9_-]{16,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{16,}\b/g,
  /\bcsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bvapi_[A-Za-z0-9_-]{16,}\b/g,
  /\bfw_[A-Za-z0-9_-]{16,}\b/g,
  /\b[a-f0-9]{32}\.[A-Za-z0-9]{10,}\b/g,
  /\b(authorization|x-api-key|x-goog-api-key)\b\s*[:=]\s*(bearer\s+)?["']?[A-Za-z0-9_\-.]{16,}["']?/gi,
];

// Exact secret strings to mask, gathered from the resolved config + environment.
// Only values of a meaningful length are included, so we never blank out e.g. a
// one-character placeholder key.
export function collectSecrets(providers?: Record<string, { apiKey?: string } | undefined>): string[] {
  const out = new Set<string>();
  const add = (v?: string) => {
    if (v && v.trim().length >= 8) out.add(v.trim());
  };
  if (providers) for (const p of Object.values(providers)) add(p?.apiKey);
  for (const k of [
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "ZAI_API_KEY",
    "Z_AI_API_KEY",
    "MOONSHOT_API_KEY",
    "CEREBRAS_API_KEY",
    "FIREWORKS_API_KEY",
    "TOGETHER_API_KEY",
    "TOGETHER_AI_API_KEY",
    "DEEPSEEK_API_KEY",
    "MINIMAX_API_KEY",
    "DASHSCOPE_API_KEY",
    "QWEN_API_KEY",
    "NEAR_AI_API_KEY",
    "NEARAI_API_KEY",
    "TINFOIL_API_KEY",
    "VENICE_API_KEY",
  ])
    add(process.env[k]);
  return [...out];
}

// Mask any known secret substrings and key-shaped tokens inside free text.
export function redactText(text: string, secrets: string[] = collectSecrets()): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join(PLACEHOLDER);
  }
  for (const re of KEY_PATTERNS) out = out.replace(re, PLACEHOLDER);
  return out;
}
