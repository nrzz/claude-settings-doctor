// A small checker for the part of JSON Schema that SchemaStore's schema for Claude Code's settings uses, and
// the lookups that `explain` and `init` need (what the schema says about a key).
//
// Judged: type (also a list of types), properties, additionalProperties (true, false or a schema),
// patternProperties, propertyNames (pattern, minLength), required, enum, const, items, minItems, maxItems,
// uniqueItems, minLength, maxLength, pattern, minimum, maximum, exclusiveMinimum, exclusiveMaximum, $ref
// inside the file, allOf, anyOf and oneOf (best effort: see anyOf below), not, and deprecated.
// Never judged, and said so (notChecked): format, if/then/else, dependencies and anything else.
//
// An issue is { path, kind, message, ... }; path is the list of keys and array indexes from the root.
// kinds: type, enum, const, required, unknown-key, range, length, pattern, items, unique, any, not, deprecated.
// Nothing here reads a file except loadSchema(); the checker takes the schema as an argument, so tests can
// give it small schemas of their own.
import fs from "node:fs";

let loaded = null;
/** The vendored schema and the record of where and when it was downloaded: { schema, meta }. */
export function loadSchema() {
  if (!loaded) {
    const read = (name) => JSON.parse(fs.readFileSync(new URL(`./schema/${name}`, import.meta.url), "utf8"));
    loaded = { schema: read("claude-code-settings.json"), meta: read("meta.json") };
  }
  return loaded;
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** What JSON calls a value: null, boolean, number, string, array or object (integers are numbers). */
export const jsonType = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

const PLURAL = { "a string": "strings", "a boolean": "booleans", "a number": "numbers", "an integer": "integers", "an object": "objects", "an array": "arrays" };
const A = { null: "null", boolean: "a boolean", number: "a number", integer: "an integer", string: "a string", array: "an array", object: "an object" };
export const article = (t) => A[t] || t;

function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => own(b, k) && sameJson(a[k], b[k]));
}

/** Edit distance with swaps of neighbours counting once (so "pemrissions" is 1 away from "permissions"). */
export function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Up to three of `names` that `key` is probably a misspelling of. */
export function nearest(key, names, max = 3) {
  const lower = key.toLowerCase();
  const allowed = Math.max(1, Math.floor(key.length / 4));
  return names
    .map((name) => ({ name, d: name.toLowerCase() === lower ? 0 : distance(lower, name.toLowerCase()) }))
    .filter((x) => x.d <= allowed && x.name !== key)
    .sort((x, y) => x.d - y.d || (x.name < y.name ? -1 : 1))
    .slice(0, max)
    .map((x) => x.name);
}

/** The schema's own words that say a key is deprecated: the keyword, or a description that starts with it. */
export function deprecation(node) {
  if (!isPlain(node)) return null;
  if (node.deprecated === true) return node.description ? firstSentence(node.description) : "the schema marks it deprecated";
  if (typeof node.description === "string" && /^deprecated\b/i.test(node.description.trim())) return firstSentence(node.description);
  return null;
}

export function firstSentence(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return m ? m[1] : t;
}

export function createSchema(root) {
  /** Follows $ref (inside this file) until a node that is not one. Returns the node, or null when it cannot. */
  function resolve(node, depth = 0) {
    let n = node;
    for (let guard = 0; isPlain(n) && typeof n.$ref === "string"; guard++) {
      if (guard > 20 || depth > 20) return null;
      if (!n.$ref.startsWith("#")) return null;
      let target = root;
      for (const part of n.$ref.slice(1).split("/").filter(Boolean)) {
        const key = decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~");
        if (!isPlain(target) && !Array.isArray(target)) return null;
        target = target[key];
        if (target === undefined) return null;
      }
      // a description next to the $ref is the more specific one
      n = isPlain(target) && typeof n.description === "string" ? { ...target, description: n.description } : target;
    }
    return n;
  }

  const typesOf = (node) => (node.type === undefined ? null : Array.isArray(node.type) ? node.type : [node.type]);
  const typeMatches = (t, v) => (t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v) : jsonType(v) === t);

  /** A short phrase for what a schema node accepts: "a boolean", "one of "a", "b"", "an array of strings". */
  function label(node, depth = 0) {
    const n = resolve(node);
    if (!isPlain(n) || depth > 3) return "a value";
    if (n.const !== undefined) return JSON.stringify(n.const);
    if (Array.isArray(n.enum)) return `one of ${n.enum.map((e) => JSON.stringify(e)).join(", ")}`;
    const alt = n.anyOf || n.oneOf;
    if (Array.isArray(alt)) return [...new Set(alt.map((a) => label(a, depth + 1)))].join(" or ");
    const ts = typesOf(n);
    if (!ts) return isPlain(n.properties) ? "an object" : "a value";
    return ts.map((t) => {
      if (t === "array" && n.items && !Array.isArray(n.items)) {
        const inner = PLURAL[label(n.items, depth + 1)];
        return inner ? `an array of ${inner}` : "an array";
      }
      return article(t);
    }).join(" or ");
  }

  /**
   * Check `value` against `node`. Returns { issues, notChecked }.
   *   at       the path of `value`, for the issues
   *   unknown  report keys that the schema does not list (default true)
   */
  function check(value, node = root, { at = [], unknown = true } = {}) {
    const issues = [];
    const notChecked = [];
    const seenNotChecked = new Set();
    const skipped = (path, keyword) => {
      const id = `${path.join("\u0000")}\u0001${keyword}`;
      if (!seenNotChecked.has(id)) { seenNotChecked.add(id); notChecked.push({ path, keyword }); }
    };

    const KNOWN = new Set(["$schema", "$id", "$ref", "$defs", "definitions", "title", "description", "default", "examples", "type", "enum", "const",
      "properties", "additionalProperties", "patternProperties", "propertyNames", "required", "items", "minItems", "maxItems", "uniqueItems",
      "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "allOf", "anyOf", "oneOf", "not",
      "deprecated", "allowTrailingCommas", "$comment", "readOnly", "writeOnly", "markdownDescription"]);
    const IGNORED = new Set(["format"]); // noted below, and only when a string is checked against it

    // validate(value, node, path, collect): fills `collect` with issues; returns nothing
    function validate(v, schemaNode, path, out, depth) {
      const n = resolve(schemaNode);
      if (n === true || n === undefined) return;
      if (n === false) { out.push({ path, kind: "not", message: "no value is allowed here" }); return; }
      if (!isPlain(n) || depth > 40) return;
      for (const k of Object.keys(n)) if (!KNOWN.has(k) && !IGNORED.has(k) && !k.startsWith("x-")) skipped(path, k);
      if (n.format !== undefined && typeof v === "string") skipped(path, "format");

      const ts = typesOf(n);
      if (ts && !ts.some((t) => typeMatches(t, v))) {
        out.push({ path, kind: "type", expected: ts, found: jsonType(v), message: `should be ${label(n)}, found ${article(jsonType(v))}`, node: n });
        return; // everything else is about a value of the right type
      }
      if (n.const !== undefined && !sameJson(n.const, v)) out.push({ path, kind: "const", message: `should be ${JSON.stringify(n.const)}`, expected: n.const, node: n });
      if (Array.isArray(n.enum) && !n.enum.some((e) => sameJson(e, v))) {
        out.push({ path, kind: "enum", message: `${JSON.stringify(v)} is not one of ${n.enum.map((e) => JSON.stringify(e)).join(", ")}`, expected: n.enum, node: n });
      }
      if (typeof v === "string") {
        if (typeof n.minLength === "number" && [...v].length < n.minLength) out.push({ path, kind: "length", message: n.minLength === 1 ? "should not be empty" : `should be at least ${n.minLength} characters`, node: n });
        if (typeof n.maxLength === "number" && [...v].length > n.maxLength) out.push({ path, kind: "length", message: `should be at most ${n.maxLength} characters`, node: n });
        if (typeof n.pattern === "string") {
          let re = null;
          try { re = new RegExp(n.pattern, "u"); } catch { try { re = new RegExp(n.pattern); } catch { skipped(path, "pattern"); } }
          if (re && !re.test(v)) out.push({ path, kind: "pattern", message: `does not match the pattern ${n.pattern}`, pattern: n.pattern, node: n });
        }
      }
      if (typeof v === "number") {
        if (typeof n.minimum === "number" && v < n.minimum) out.push({ path, kind: "range", message: `should be at least ${n.minimum}`, node: n });
        if (typeof n.maximum === "number" && v > n.maximum) out.push({ path, kind: "range", message: `should be at most ${n.maximum}`, node: n });
        if (typeof n.exclusiveMinimum === "number" && v <= n.exclusiveMinimum) out.push({ path, kind: "range", message: `should be more than ${n.exclusiveMinimum}`, node: n });
        if (typeof n.exclusiveMaximum === "number" && v >= n.exclusiveMaximum) out.push({ path, kind: "range", message: `should be less than ${n.exclusiveMaximum}`, node: n });
      }
      if (Array.isArray(v)) {
        if (typeof n.minItems === "number" && v.length < n.minItems) out.push({ path, kind: "items", message: `should have at least ${n.minItems} item${n.minItems === 1 ? "" : "s"}`, node: n });
        if (typeof n.maxItems === "number" && v.length > n.maxItems) out.push({ path, kind: "items", message: `should have at most ${n.maxItems} item${n.maxItems === 1 ? "" : "s"}`, node: n });
        if (n.uniqueItems === true) {
          const firstSeen = [];
          v.forEach((x, i) => {
            const j = firstSeen.findIndex((y) => sameJson(x, y.value));
            if (j >= 0) out.push({ path: [...path, i], kind: "unique", message: `repeats item ${firstSeen[j].index} (items should be different)`, node: n, of: firstSeen[j].index });
            else firstSeen.push({ value: x, index: i });
          });
        }
        if (n.items !== undefined) {
          if (Array.isArray(n.items)) n.items.forEach((s, i) => { if (i < v.length) validate(v[i], s, [...path, i], out, depth + 1); });
          else v.forEach((x, i) => validate(x, n.items, [...path, i], out, depth + 1));
        }
      }
      if (isPlain(v)) {
        const props = isPlain(n.properties) ? n.properties : null;
        const patterns = isPlain(n.patternProperties) ? Object.entries(n.patternProperties) : [];
        const patternRes = patterns.map(([p, s]) => { try { return [new RegExp(p, "u"), s]; } catch { skipped(path, "patternProperties"); return null; } }).filter(Boolean);
        if (Array.isArray(n.required)) for (const r of n.required) if (!own(v, r)) out.push({ path, kind: "required", key: r, message: `needs the key "${r}"`, node: n });
        for (const [k, child] of Object.entries(v)) {
          const here = [...path, k];
          if (isPlain(n.propertyNames)) {
            const names = [];
            validate(k, n.propertyNames, here, names, depth + 1);
            for (const issue of names) out.push({ ...issue, path: here, at: "key", message: `the name ${issue.message}` });
          }
          if (props && own(props, k)) {
            const sub = resolve(props[k]);
            const dep = deprecation(sub);
            if (dep) out.push({ path: here, kind: "deprecated", at: "key", message: dep, node: sub });
            validate(child, props[k], here, out, depth + 1);
            continue;
          }
          const hit = patternRes.filter(([re]) => re.test(k));
          if (hit.length) { for (const [, s] of hit) validate(child, s, here, out, depth + 1); continue; }
          if (isPlain(n.additionalProperties)) { validate(child, n.additionalProperties, here, out, depth + 1); continue; }
          if (props && unknown) {
            out.push({ path: here, kind: "unknown-key", at: "key", strict: n.additionalProperties === false, known: Object.keys(props), message: "is not in the schema", node: n });
          }
        }
      }
      if (Array.isArray(n.allOf)) for (const s of n.allOf) validate(v, s, path, out, depth + 1);
      if (n.not !== undefined) {
        const inner = [];
        validate(v, n.not, path, inner, depth + 1);
        if (inner.length === 0) out.push({ path, kind: "not", message: "is not allowed here", node: n });
      }
      for (const key of ["anyOf", "oneOf"]) {
        if (!Array.isArray(n[key])) continue;
        const tries = n[key].map((s) => { const sub = []; validate(v, s, path, sub, depth + 1); return { s: resolve(s), sub }; });
        const ok = tries.filter((t) => t.sub.length === 0).length;
        if (ok > 0) continue; // oneOf wants exactly one; "at least one" is as far as this goes
        // none fits: say why with the alternative the value is closest to
        let pick = null;
        if (isPlain(v)) pick = tries.find((t) => isPlain(t.s) && isPlain(t.s.properties) && isPlain(t.s.properties.type) && t.s.properties.type.const !== undefined && t.s.properties.type.const === v.type) || null;
        if (!pick) {
          const sameType = tries.filter((t) => isPlain(t.s) && typesOf(t.s) && typesOf(t.s).some((tt) => typeMatches(tt, v)));
          if (sameType.length === 1) pick = sameType[0];
        }
        if (pick) { out.push(...pick.sub); continue; }
        out.push({ path, kind: "any", message: `should be ${label(n)}`, expected: n[key].map((s) => label(s)), found: jsonType(v), node: n });
      }
    }
    validate(value, node, at, issues, 0);
    return { issues, notChecked };
  }

  /**
   * What the schema says about the key path (a list of keys and indexes), or null when it says nothing.
   * { node, known: true, names (the keys an object lists), via }
   */
  function nodeAt(pathSegments) {
    let node = resolve(root);
    for (let i = 0; i < pathSegments.length; i++) {
      const seg = pathSegments[i];
      node = descend(node, seg, pathSegments.slice(i + 1));
      if (!node) return null;
      if (node.consumed > 1) i += node.consumed - 1;
      node = node.node;
    }
    return node ? { node: resolve(node) } : null;
  }

  // One step down: returns { node, consumed } or null. A key with dots in it takes several segments.
  function descend(node, seg, rest) {
    const n = resolve(node);
    if (!isPlain(n)) return null;
    const alternatives = n.anyOf || n.oneOf;
    if (Array.isArray(alternatives)) {
      for (const alt of alternatives) { const r = descend(alt, seg, rest); if (r) return r; }
      return null;
    }
    if (Array.isArray(n.allOf)) for (const alt of n.allOf) { const r = descend(alt, seg, rest); if (r) return r; }
    const isIndex = typeof seg === "number" || /^\d+$/.test(String(seg)) || seg === "*";
    if (n.items !== undefined && isIndex) return { node: Array.isArray(n.items) ? n.items[Number(seg)] : n.items, consumed: 1 };
    if (isPlain(n.properties)) {
      for (let k = 1; k <= rest.length + 1; k++) {
        const key = [seg, ...rest.slice(0, k - 1)].join(".");
        if (own(n.properties, key)) return { node: n.properties[key], consumed: k };
      }
    }
    if (isPlain(n.patternProperties)) {
      for (const [p, s] of Object.entries(n.patternProperties)) { try { if (new RegExp(p).test(String(seg))) return { node: s, consumed: 1 }; } catch { /* skip */ } }
    }
    if (isPlain(n.additionalProperties)) {
      const child = resolve(n.additionalProperties);
      const structured = isPlain(child) && (isPlain(child.properties) || child.items !== undefined || child.anyOf || child.oneOf);
      return { node: n.additionalProperties, consumed: structured ? 1 : 1 + rest.length };
    }
    return null;
  }

  /** The keys the schema lists for an object at this path (empty when it lists none). */
  function namesAt(pathSegments) {
    const hit = nodeAt(pathSegments);
    if (!hit) return [];
    const names = new Set();
    const collect = (nd, depth = 0) => {
      const r = resolve(nd);
      if (!isPlain(r) || depth > 4) return;
      if (isPlain(r.properties)) for (const k of Object.keys(r.properties)) names.add(k);
      for (const a of [...(r.anyOf || []), ...(r.oneOf || []), ...(r.allOf || [])]) collect(a, depth + 1);
    };
    collect(hit.node);
    return [...names];
  }

  /** The same as label, without the articles: "string or object", "array of strings", "one of ...". */
  function typeText(node) {
    return label(node).split(" or ").map((part) => (part.startsWith("one of ") ? part : part.replace(/^an? /, ""))).join(" or ");
  }

  return { root, resolve, check, label, typeText, nodeAt, namesAt };
}

let shared = null;
/** The checker for the vendored schema. */
export function vendored() {
  if (!shared) shared = createSchema(loadSchema().schema);
  return shared;
}
