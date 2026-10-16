// A seeded generator of random JSON values and of JSONC texts that hold them (with comments, blank lines,
// trailing commas, tabs or spaces, LF or CRLF), for the tests that must hold for any document.

/** A small seeded generator: mulberry32. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (r, list) => list[Math.floor(r() * list.length)];

/** A random settings-like value: objects with a few keys, lists of strings or objects, scalars. */
export function randomValue(r, depth = 0, { keys = ["model", "env", "permissions", "hooks", "a", "b", "c", "theme", "allow", "deny", "FOO", "BAR"] } = {}) {
  const x = r();
  if (depth > 3 || x < 0.3) return pick(r, ["a", "b", "Bash(ls)", "Bash(npm test)", 1, 2, 30, true, false, null, "line\nbreak", "ü", ""]);
  if (x < 0.55) return Array.from({ length: Math.floor(r() * 4) }, () => (r() < 0.2 ? randomValue(r, depth + 1, { keys }) : pick(r, ["Bash(ls)", "Bash(git status)", "Read(./.env)", "x", "y", 1, 2])));
  const o = {};
  for (let k = Math.floor(r() * 5); k > 0; k--) o[pick(r, keys)] = randomValue(r, depth + 1, { keys });
  return o;
}

/**
 * JSONC text for a value, written the way a person might: some comments (kept in `comments`), blank lines, a
 * trailing comma now and then, one-line containers now and then.
 */
export function render(value, r, { eol = "\n", unit = "  ", comments = true, trailing = true } = {}) {
  const notes = [];
  let n = 0;
  const note = () => { const text = `note ${n++}`; notes.push(text); return text; };
  const out = (v, level) => {
    const pad = unit.repeat(level + 1);
    const close = unit.repeat(level);
    if (Array.isArray(v)) {
      if (v.length === 0) return r() < 0.3 && comments ? `[ /* ${note()} */ ]` : "[]";
      if (r() < 0.25 && v.every((x) => typeof x !== "object" || x === null)) return `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
      const lines = v.map((x, i) => {
        let s = "";
        if (comments && r() < 0.3) s += `${pad}// ${note()}${eol}`;
        s += `${pad}${out(x, level + 1)}`;
        const last = i === v.length - 1;
        if (!last || (trailing && r() < 0.3)) s += ",";
        if (comments && r() < 0.2) s += ` // ${note()}`;
        return s;
      });
      return `[${eol}${lines.join(eol)}${eol}${close}]`;
    }
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v);
      if (entries.length === 0) return r() < 0.3 && comments ? `{ // ${note()}${eol}${close}}` : "{}";
      const lines = entries.map(([k, x], i) => {
        let s = "";
        if (i > 0 && r() < 0.25) s += eol;
        if (comments && r() < 0.35) s += `${pad}// ${note()}${eol}`;
        if (comments && r() < 0.1) s += `${pad}/* ${note()} */${eol}`;
        s += `${pad}${JSON.stringify(k)}: ${out(x, level + 1)}`;
        const last = i === entries.length - 1;
        if (!last || (trailing && r() < 0.3)) s += ",";
        if (comments && r() < 0.2) s += ` // ${note()}`;
        return s;
      });
      return `{${eol}${lines.join(eol)}${eol}${close}}`;
    }
    return JSON.stringify(v);
  };
  let text = "";
  if (comments && r() < 0.5) text += `// ${note()}${eol}`;
  text += out(value, 0);
  if (comments && r() < 0.3) text += ` // ${note()}`;
  text += eol;
  return { text, notes };
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A copy of `value` with a few random changes, the kind Claude Code makes to settings.json and people make in a
 * file: a key added at any depth, a scalar changed, an item pushed on a list, and (unless `removals` is false) a
 * key or an item taken out. Every key and item it adds is new, so lists never gain a repeat.
 */
export function mutate(value, r, { removals = true, steps = 1 + Math.floor(r() * 4) } = {}) {
  const copy = structuredClone(value);
  let fresh = 0;
  for (let s = 0; s < steps; s++) {
    const spots = [];
    const walk = (node) => {
      if (isObject(node)) { spots.push(node); for (const v of Object.values(node)) walk(v); }
      else if (Array.isArray(node)) { spots.push(node); node.forEach(walk); }
    };
    walk(copy);
    const node = pick(r, spots);
    if (Array.isArray(node)) {
      if (removals && node.length && r() < 0.4) node.splice(Math.floor(r() * node.length), 1);
      else node.push(r() < 0.8 ? `Bash(new ${fresh++})` : { added: fresh++ });
    } else {
      const keys = Object.keys(node);
      const x = r();
      if (x < 0.45 || keys.length === 0) node[`added${fresh++}`] = pick(r, [`v${fresh}`, fresh, true, ["a" + fresh], { inner: fresh }]);
      else {
        const k = pick(r, keys);
        if (x < 0.7 && !isObject(node[k]) && !Array.isArray(node[k])) node[k] = pick(r, [`changed${fresh++}`, fresh, false, null]);
        else if (removals) delete node[k];
        else if (Array.isArray(node[k])) node[k].push(`Bash(more ${fresh++})`);
      }
    }
  }
  return copy;
}
