// `crypto_lookup` — live crypto market and Solana wallet data, served by Privateer.
//
// Same posture as web_search (see web.ts's header, which applies here word for word):
// the call goes to the account API (`/api/rag/crypto`) with the session credential
// this agent already holds, so no data-provider key ever sits in a harbor's
// environment. The server resolves the lookup — Solana tickers through Jupiter's
// verified token registry, market data from DexScreener, wallet holdings from the
// Solana RPC — and hands back a formatted block.
//
// WHAT LEAVES. The tickers, or the wallet address, reach Privateer's servers and the
// public data providers in plaintext; the run's prompt and result do not. That is the
// web_search trade exactly, which is why this tool rides the same "web access" switch
// on unattended paths (harbor/channels/ACP add it to their WEB_TOOLS allow-lists).
//
// "MY WALLET" IS THE ACCOUNT'S, NEVER A CLAIM. `portfolio` without an address reads the
// Solana wallet the account signed in with, and the server takes it from the account
// record, not from this request. A pasted address is public chain state.
//
// READ-ONLY. Nothing here signs, swaps or moves funds, and the result tells the model
// it is information, not financial advice.

import { Type } from "typebox";
import { hasCredentials } from "../auth/privateer.ts";
import { callRag, text } from "./web.ts";

/** Tool names this module registers, for allow-list construction. */
export const CRYPTO_TOOL_NAMES = ["crypto_lookup"] as const;

const MODES = ["tokens", "portfolio", "new", "boosted"] as const;
type Mode = (typeof MODES)[number];

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const cryptoLookupToolDefinition = {
  name: "crypto_lookup",
  label: "Crypto Lookup",
  description:
    "Live crypto market and Solana wallet data. Modes: " +
    "`tokens` — price, 1h/24h change, volume, liquidity, market cap, holders and pair age for up to four " +
    "tickers, names or contract addresses (Solana tickers are matched against the verified token registry; " +
    "BTC/ETH/BNB are priced from their wrapped forms); " +
    "`portfolio` — a Solana wallet's holdings priced and totalled (omit `address` for the signed-in account's " +
    "own wallet); `new` — the newest token listings; `boosted` — tokens paying for promotion on DexScreener " +
    "(paid placement, not organic popularity). Use this rather than web_search for prices and holdings; use " +
    "web_search for crypto NEWS. Read-only. Runs through the user's Privateer account — the tickers or " +
    "address are visible to Privateer's servers.",
  parameters: Type.Object({
    mode: Type.Optional(Type.Union(MODES.map((m) => Type.Literal(m)), { description: "What to look up. Defaults to tokens." })),
    query: Type.Optional(Type.String({ description: "tokens mode: comma-separated tickers, names or contract addresses, e.g. \"SOL, BONK\"." })),
    address: Type.Optional(Type.String({ description: "portfolio mode: a Solana wallet address. Omit for the account's own wallet." })),
    chain: Type.Optional(Type.String({ description: "new/boosted: narrow to one chain, e.g. \"solana\", \"ethereum\", \"base\", \"bsc\"." })),
  }),
  async execute(_toolCallId: string, params: { mode?: Mode; query?: string; address?: string; chain?: string }) {
    const mode: Mode = MODES.includes(params.mode as Mode) ? (params.mode as Mode) : "tokens";
    const query = String(params.query ?? "").trim();
    const address = String(params.address ?? "").trim();
    if (mode === "tokens" && !query) return text("Error: query is required in tokens mode (e.g. \"SOL, BONK\").");
    if (address && !SOLANA_ADDRESS.test(address)) return text("Error: address must be a Solana wallet address.");

    const body: Record<string, unknown> = { mode, raw: true };
    if (mode === "tokens") body.query = query;
    if (mode === "portfolio" && address) body.address = address;
    const chain = String(params.chain ?? "").trim().toLowerCase();
    if ((mode === "new" || mode === "boosted") && chain) body.chain = chain;

    const r = await callRag<{ found?: boolean; text?: string }>("/api/rag/crypto", body);
    if (!r.ok) return text(`Crypto lookup failed: ${r.message}`);
    if (!r.data.found || !r.data.text) {
      return text(
        mode === "tokens"
          ? `No DEX market found for ${query}. It may not trade on-chain, or the ticker may be spelled differently — try a contract address, or web_search.`
          : "No market data came back for that lookup.",
      );
    }
    return text(r.data.text);
  },
};

/** Extension factory for the unattended paths (see config/moat.ts), beside makeWebTools. */
export function makeCryptoTools() {
  return (pi: { registerTool?: (def: unknown) => void }): void => {
    pi.registerTool?.(cryptoLookupToolDefinition);
  };
}

/**
 * The interactive form: a sign-in check per call, for the same reason
 * guardedWebToolDefinitions has one (a terminal signs in mid-session). Registered in
 * BOTH of privateer-web.ts's branches — unlike web_search there is no user-configured
 * provider for this to compete with, so choosing your own search engine must not cost
 * you market data.
 */
export function guardedCryptoToolDefinitions(hint: string): unknown[] {
  return [{
    ...cryptoLookupToolDefinition,
    async execute(toolCallId: string, params: any) {
      if (!hasCredentials()) return text(hint);
      return cryptoLookupToolDefinition.execute(toolCallId, params);
    },
  }];
}
