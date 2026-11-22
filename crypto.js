// claude-dispatch protocol v1: gzip, then AES-256-GCM with a direction-bound AAD.
// Works in browsers and in Node >= 18 (globalThis.crypto + CompressionStream).

export const VERSION = 1;
export const AAD = { req: "cd1|req", res: "cd1|res" };
/** ntfy rejects bodies over 4096 bytes. */
export const MAX_BODY = 3800;
/** Upper bound on decompressed plaintext; larger input is treated as garbage. */
const MAX_PLAINTEXT = 32 * 1024 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function b64urlDecode(str) {
  const s = str.trim().replace(/-/g, "+").replace(/_/g, "/");
  return b64decode(s + "=".repeat((4 - (s.length % 4)) % 4));
}

export function randomHex(nBytes) {
  const b = crypto.getRandomValues(new Uint8Array(nBytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Imports a base64url (no padding) 32-byte key as a non-extractable AES-GCM key. */
export async function importKey(b64url) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(b64url.trim())) throw new Error("Key must be 43 base64url characters");
  const raw = b64urlDecode(b64url);
  if (raw.length !== 32) throw new Error("Key must decode to 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function pipe(bytes, stream, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (limit && total > limit) {
      await reader.cancel();
      throw new Error("plaintext too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export const gzip = (bytes) => pipe(bytes, new CompressionStream("gzip"));
export const gunzip = (bytes) => pipe(bytes, new DecompressionStream("gzip"), MAX_PLAINTEXT);

/**
 * Seals a message object (or a pre-serialised JSON string) for `dir` ("req" | "res").
 * Returns the envelope as a JSON string. `iv` is only for test vectors.
 */
export async function seal(key, dir, msg, iv) {
  if (!AAD[dir]) throw new Error("bad direction");
  const plaintext = typeof msg === "string" ? msg : JSON.stringify(msg);
  const compressed = await gzip(enc.encode(plaintext));
  iv = iv || crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(AAD[dir]) }, key, compressed),
  );
  return JSON.stringify({ v: VERSION, d: dir, iv: b64encode(iv), ct: b64encode(ct) });
}

/** True if `text` parses as a v1 envelope for `dir`; says nothing about the key. */
export function looksLikeEnvelope(text, dir) {
  try {
    const e = typeof text === "string" ? JSON.parse(text) : text;
    return e && e.v === VERSION && e.d === dir && typeof e.iv === "string" && typeof e.ct === "string";
  } catch {
    return false;
  }
}

/** Opens an envelope and returns the plaintext string, or null on any failure. */
export async function openText(key, dir, text) {
  try {
    if (text instanceof Uint8Array) text = dec.decode(text);
    const e = JSON.parse(text);
    if (!looksLikeEnvelope(e, dir)) return null;
    const iv = b64decode(e.iv);
    if (iv.length !== 12) return null;
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(AAD[dir]) },
      key,
      b64decode(e.ct),
    );
    return dec.decode(await gunzip(new Uint8Array(pt)));
  } catch {
    return null;
  }
}

/** Opens an envelope and returns the parsed inner message, or null on any failure. */
export async function open(key, dir, text) {
  const s = await openText(key, dir, text);
  if (s === null) return null;
  try {
    const m = JSON.parse(s);
    return m && typeof m === "object" && typeof m.id === "string" && typeof m.type === "string" ? m : null;
  } catch {
    return null;
  }
}

/** Builds a request with the common fields filled in. */
export function request(type, fields = {}) {
  return { id: randomHex(16), ts: Math.floor(Date.now() / 1000), type, from: "phone", ...fields };
}
