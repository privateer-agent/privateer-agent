// bech32 (BIP-173) — just enough of it for NIP-19's `npub` / `nsec` key encodings.
//
// WHY HAND-ROLLED: this repo's channel stack advertises zero new dependencies and
// means it. bech32 is a fully specified, ~70-line checksum with published test
// vectors, and we need exactly two human-readable parts and no TLV forms — none of
// the `nprofile`/`nevent` machinery a general NIP-19 library carries. The tests in
// tests/nostr.test.ts drive the published vectors both directions.
//
// This is bech32, NOT bech32m: NIP-19 predates bech32m and uses the original
// constant 1. The two differ only in that final XOR, and getting it wrong produces
// strings that look right and fail everywhere else.
//
// BIP-173's 90-character total length cap is deliberately NOT enforced — NIP-19
// explicitly drops it. `npub` is 63 characters so it makes no difference today, but
// enforcing it would be a landmine for any longer form added later.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GENERATOR[i];
  }
  return chk;
}

// The HRP contributes its high bits, then a separator zero, then its low bits.
function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

// Regroup a bit stream, e.g. 8-bit bytes → 5-bit symbols and back. When padding is
// allowed (encoding) a partial final group is zero-padded; when it isn't (decoding)
// a partial group must be zero or the input is malformed.
function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const words = convertBits(bytes, 8, 5, true);
  if (!words) throw new Error("bech32: cannot convert payload to 5-bit words");
  const chk = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((chk >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

/** Decode, throwing on any malformed input. Never returns partial or truncated data. */
export function bech32Decode(s: string): { hrp: string; bytes: Uint8Array } {
  // Mixed case is explicitly invalid — it would make the checksum ambiguous.
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error("bech32: mixed case");
  const lower = s.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) throw new Error("bech32: malformed (no separator or too short)");
  const hrp = lower.slice(0, sep);
  const words: number[] = [];
  for (const ch of lower.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) throw new Error(`bech32: invalid character "${ch}"`);
    words.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) throw new Error("bech32: bad checksum");
  const bytes = convertBits(words.slice(0, -6), 5, 8, false);
  if (!bytes) throw new Error("bech32: bad padding");
  return { hrp, bytes: Uint8Array.from(bytes) };
}

// ── NIP-19: the two bare key forms ──────────────────────────────────────────────

function decodeKey(s: string, expectHrp: string): Uint8Array {
  const { hrp, bytes } = bech32Decode(s);
  if (hrp !== expectHrp) throw new Error(`expected an ${expectHrp} key, got "${hrp}"`);
  if (bytes.length !== 32) throw new Error(`expected 32 key bytes, got ${bytes.length}`);
  return bytes;
}

export function npubEncode(pubkeyBytes: Uint8Array): string {
  return bech32Encode("npub", pubkeyBytes);
}

export function npubDecode(npub: string): Uint8Array {
  return decodeKey(npub, "npub");
}

export function nsecEncode(secretBytes: Uint8Array): string {
  return bech32Encode("nsec", secretBytes);
}

export function nsecDecode(nsec: string): Uint8Array {
  return decodeKey(nsec, "nsec");
}
