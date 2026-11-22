// Parses the compose line: `<prompt...> <work> [@machine]`.

/**
 * @param {string} line
 * @param {Array<{machine: string, works: string[]}>} machines latest hello replies
 * @returns {{prompt: string, work: string, target: string, error?: string, choices?: string[]}}
 */
export function parseCommand(line, machines = []) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  let target = "";
  if (tokens.length && tokens[tokens.length - 1].startsWith("@")) {
    target = tokens.pop().slice(1).toLowerCase();
  }
  const work = tokens.length >= 2 ? tokens.pop() : "";
  const prompt = tokens.join(" ");
  const out = { prompt, work, target };
  if (!prompt || !work) {
    out.error = "Format: <prompt> <work> [@machine]";
    return out;
  }
  if (!machines.length) return out;
  const owners = machines.filter((m) => (m.works || []).includes(work)).map((m) => m.machine);
  if (target) {
    if (!machines.some((m) => m.machine === target)) out.error = `Unknown machine @${target}`;
    else if (!owners.includes(target)) out.error = `@${target} does not have work "${work}"`;
  } else if (!owners.length) {
    out.error = `No machine has work "${work}"`;
  } else if (owners.length > 1) {
    out.error = `"${work}" is on several machines; pick one`;
    out.choices = owners;
  }
  return out;
}
