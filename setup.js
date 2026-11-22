// Setup codes produced by `cdispatch pair`: base64url JSON {v, s, q, r, k}, usually inside a
// page link as `#setup=<code>`. The fragment never reaches the web server.

/**
 * Parses a bare code or any text containing `#setup=<code>`.
 * @returns {{server: string, req: string, res: string, key: string} | null}
 */
export function parseSetup(input) {
  try {
    let code = String(input).trim();
    const i = code.indexOf("#setup=");
    if (i >= 0) code = code.slice(i + 7);
    code = code.split(/[&#\s]/)[0];
    if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
    const b64 = code.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0)),
    );
    const o = JSON.parse(json);
    if (o.v !== 1) return null;
    const out = { server: String(o.s || "").replace(/\/+$/, ""), req: String(o.q || ""), res: String(o.r || ""), key: String(o.k || "") };
    if (!out.server.startsWith("https://") || !out.req || !out.res || out.req === out.res) return null;
    if (!/^[A-Za-z0-9_-]{43}$/.test(out.key)) return null;
    return out;
  } catch {
    return null;
  }
}
