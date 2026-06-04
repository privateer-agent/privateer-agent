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
      headers: { "user-agent": "privateer/0.0.1 (+https://github.com/zahnno/privateer-agentic-tui)" },
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

      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      let result;
      try {
        result = await fetchText(url);
      } catch (err) {
        return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
      }
      const results = parseDdg(result.body, 8);
      return results.length
        ? `Results for "${query}":\n\n${results.join("\n\n")}`
        : `No results parsed for "${query}" (DuckDuckGo markup may have changed). Try web_fetch with a direct URL.`;
    },
  });
}
