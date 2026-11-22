// Compose line: `<laptop> <repo> <anything for Claude>`.
// The prompt is everything after the repo, kept verbatim (newlines included).
// Shorthand: `<repo> <anything>` when exactly one laptop has that repo.

/** Splits off the first `n` whitespace-delimited tokens; `rest` keeps its inner whitespace. */
function head(text, n) {
  const tokens = [];
  let rest = text.replace(/^\s+/, "");
  for (let i = 0; i < n; i++) {
    const m = rest.match(/^(\S+)(\s+|$)/);
    if (!m) break;
    tokens.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return { tokens, rest };
}

const bare = (t) => (t || "").replace(/^@/, "").toLowerCase();

/**
 * @param {string} line
 * @param {Array<{machine: string, works: string[]}>} machines latest hello replies
 * @returns {{target: string, work: string, prompt: string, error?: string, choices?: string[]}}
 */
export function parseCommand(line, machines = []) {
  const { tokens, rest } = head(line, 2);
  const [t1, t2] = tokens;
  const byName = new Map(machines.map((m) => [m.machine.toLowerCase(), m]));
  const fail = (error, extra = {}) => ({ target: "", work: "", prompt: "", error, ...extra });

  if (!t1) return fail("Write: laptop repo what-to-do");

  if (!machines.length) {
    if (!t2 || !rest.trim()) return fail("Write: laptop repo what-to-do");
    return { target: bare(t1), work: t2, prompt: rest.trim() };
  }

  const m = byName.get(bare(t1));
  if (m) {
    if (!t2) return fail(`Pick a repo on ${m.machine}`);
    if (!m.works.includes(t2)) return fail(`${m.machine} has no repo "${t2}". It has: ${m.works.join(", ") || "none"}`);
    if (!rest.trim()) return fail("Add what Claude should do");
    return { target: m.machine, work: t2, prompt: rest.trim() };
  }

  const owners = machines.filter((x) => x.works.includes(t1)).map((x) => x.machine);
  if (!owners.length) return fail(`"${t1}" is not a laptop or a repo. Laptops: ${[...byName.values()].map((x) => x.machine).join(", ")}`);
  const prompt = line.replace(/^\s*\S+\s*/, "").trim();
  if (!prompt) return fail("Add what Claude should do");
  if (owners.length > 1) return fail(`"${t1}" is on several laptops; pick one`, { choices: owners, work: t1, prompt });
  return { target: owners[0], work: t1, prompt };
}

/**
 * What to offer while typing: laptops for the first word, that laptop's repos for the second,
 * nothing once the prompt starts.
 * @returns {{kind: "machine" | "repo" | null, items: string[], prefix: string}}
 */
export function suggest(line, machines = []) {
  const none = { kind: null, items: [], prefix: "" };
  if (!machines.length) return none;
  const { tokens, rest } = head(line, 2);
  const endsWithSpace = /\s$/.test(line);
  const names = machines.map((m) => m.machine);

  if (tokens.length === 0 || (tokens.length === 1 && !endsWithSpace)) {
    const typed = bare(tokens[0]);
    const items = names.filter((n) => n.toLowerCase().startsWith(typed));
    return { kind: "machine", items: items.length ? items : names, prefix: "" };
  }

  const m = machines.find((x) => x.machine.toLowerCase() === bare(tokens[0]));
  if (!m) return none;
  if (tokens.length === 1 || (tokens.length === 2 && !endsWithSpace && !rest)) {
    const typed = tokens[1] || "";
    const items = m.works.filter((w) => w.startsWith(typed));
    return { kind: "repo", items: items.length ? items : m.works, prefix: `${m.machine} ` };
  }
  return none;
}
