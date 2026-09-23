/**
 * The two public bearer tokens (renewal link, calendar feed). A token is the
 * prefix plus 64 hex characters (32 random bytes) — twice the length of a
 * public id, so the two can never be confused. Only the SHA-256 of the whole
 * token is stored; the raw value exists once, in the minting response.
 */
export const RENEWAL_TOKEN_PREFIX = "exl_";
export const FEED_TOKEN_PREFIX = "exf_";
const TOKEN_RE = /^(exl|exf)_[0-9a-f]{64}$/;

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i++) out += view[i]!.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const input: ArrayBuffer =
    typeof data === "string" ? (new TextEncoder().encode(data).buffer as ArrayBuffer) : data;
  return hex(await crypto.subtle.digest("SHA-256", input));
}

export async function mintToken(prefix: string): Promise<{ raw: string; hash: string }> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const raw = `${prefix}${hex(buf)}`;
  return { raw, hash: await sha256Hex(raw) };
}

/** Shape check before any lookup: a malformed token is `not_found` without touching D1. */
export function isWellFormedToken(raw: string | null | undefined, prefix: string): raw is string {
  return typeof raw === "string" && TOKEN_RE.test(raw) && raw.startsWith(prefix);
}
