import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { PermissionDeniedError } from "../permissions/gate.ts";

const MAX_BYTES = 2_000_000; // cap download size
const MAX_TEXT = 20_000; // cap returned text
const TIMEOUT_MS = 20_000;

// Fetch a URL's body as text, with a timeout and size cap. Returns null fields on failure.
async function fetchText(url: string): Promise<{ status: number; contentType: string; body: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": "privateer-agent/0.1.0 (+https://github.com/privateer-agent/privateer-agent)" },
    });
    const body = (await res.text()).slice(0, MAX_BYTES);
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", body };
  } finally {
    clearTimeout(timer);
  }
}

// Crude HTML→text: drop scripts/styles, turn block-closers into newlines, strip tags,
// decode the common entities. Good enough to feed page content to the model.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function webFetchTool(ctx: ToolContext) {
  return tool({
    description:
      "Fetch a URL and return its content as text (HTML is stripped to readable text). Use when " +
      "the user gives a link or you need to read online docs. Network egress, so it may prompt.",
    inputSchema: z.object({
      url: z.string().describe("Absolute http(s) URL to fetch."),
      prompt: z.string().optional().describe("What you're looking for (recorded for context; not a separate model call)."),
    }),
    execute: async ({ url, prompt }) => {
      if (!isHttpUrl(url)) return `Error: not a valid http(s) URL: ${url}`;
      const decision = await ctx.gate.request({
        tool: "web_fetch",
        kind: "fetch",
        title: "Fetch URL",
        detail: url,
      });
      if (decision === "deny") throw new PermissionDeniedError("web_fetch");

      let result;
      try {
        result = await fetchText(url);
      } catch (err) {
        return `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
      const text = /html/i.test(result.contentType) ? htmlToText(result.body) : result.body.trim();
      const capped = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n… (truncated)" : text;
      const header = `[${result.status} · ${result.contentType || "?"}]${prompt ? ` looking for: ${prompt}` : ""}`;
      return `${header}\n\n${capped || "(empty response)"}`;
    },
  });
}

// DuckDuckGo's keyless HTML endpoint, scraped for result titles + links. No API key
// required, which keeps web_search working out of the box.
// Caveat: it scrapes HTML, so it's best-effort and can break if DDG changes markup.
function parseDdg(html: string, limit: number): string[] {
  const out: string[] = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < limit) {
    const href = decodeDdgHref(m[1]);
    const title = htmlToText(m[2]);
    if (title) out.push(`${title}\n  ${href}`);
  }
  return out;
}

// DDG's lite endpoint (used as a fallback) lays results out as <a class="result-link">.
function parseDdgLite(html: string, limit: number): string[] {
  const out: string[] = [];
  const re = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < limit) {
    const href = decodeDdgHref(m[1]);
    const title = htmlToText(m[2]);
    if (title) out.push(`${title}\n  ${href}`);
  }
  return out;
}

// DuckDuckGo rate-limits by IP: after the first request or two it serves an HTTP 202
// "anomaly" challenge page with zero results instead of blocking outright. If we don't
// recognize that, web_search reports "no results" and the model keeps re-searching —
// looking, to the user, like it hangs forever. Detect the challenge so we can return a
// terminal message that tells the model to stop retrying.
function isDdgBlocked(status: number, body: string): boolean {
  if (status === 202 || status === 429) return true;
  return /anomaly-modal|If this error persists|Unfortunately, bots use DuckDuckGo/i.test(body);
}

// DDG wraps results as //duckduckgo.com/l/?uddg=<encoded real url>.
function decodeDdgHref(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : u.toString();
  } catch {
    return href;
  }
}

export function webSearchTool(ctx: ToolContext) {
  return tool({
    description:
      "Search the web and return the top results (title + URL) via DuckDuckGo. Follow up with " +
      "web_fetch to read a result. Network egress, so it may prompt.",
    inputSchema: z.object({
      query: z.string().describe("Search query."),
    }),
    execute: async ({ query }) => {
      const decision = await ctx.gate.request({
        tool: "web_search",
        kind: "fetch",
        title: "Web search",
        detail: query,
      });
      if (decision === "deny") throw new PermissionDeniedError("web_search");

      const q = encodeURIComponent(query);
      // Primary: the HTML endpoint. Fallback: the lite endpoint, whose markup differs.
      // Both are keyless and both get rate-limited by IP, so we try each once and read
      // the block signal rather than retrying blindly (which is what spun forever).
      const attempts: Array<{ url: string; parse: (b: string, n: number) => string[] }> = [
        { url: `https://html.duckduckgo.com/html/?q=${q}`, parse: parseDdg },
        { url: `https://lite.duckduckgo.com/lite/?q=${q}`, parse: parseDdgLite },
      ];

      let blocked = false;
      for (const attempt of attempts) {
        let result;
        try {
          result = await fetchText(attempt.url);
        } catch (err) {
          return `Error searching: ${err instanceof Error ? err.message : String(err)}. Do not immediately retry web_search; use web_fetch on a specific URL instead.`;
        }
        if (isDdgBlocked(result.status, result.body)) {
          blocked = true;
          continue; // try the next endpoint before giving up
        }
        const results = attempt.parse(result.body, 8);
        if (results.length) return `Results for "${query}":\n\n${results.join("\n\n")}`;
      }

      // Every endpoint either blocked us or returned nothing. Return a terminal message:
      // the key is telling the model NOT to keep calling web_search, which is what made
      // the tool appear to hang forever when DuckDuckGo was rate-limiting the machine.
      return blocked
        ? `Web search is temporarily rate-limited by DuckDuckGo (anti-bot challenge). This is transient and IP-based — retrying web_search now will keep failing. Instead, use web_fetch on a specific URL you already know, answer from what you have, or ask the user to try again in a few minutes.`
        : `No results for "${query}". Do not retry the same search repeatedly; try a different query once, or use web_fetch on a direct URL.`;
    },
  });
}
