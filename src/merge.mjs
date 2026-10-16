// The merge of the settings files into the one object Claude Code works with, and where each part came from.
//
// The rules, and how each was checked (README, "What was verified"):
//   - the files merge from the lowest precedence up: user, project, local, then managed (managed from the
//     docs; the first three against the real binary, with env, model and hooks)
//   - objects merge key by key, the higher precedence winning each key path (checked: env keys from three files
//     all arrived, the highest one's value won)
//   - arrays are joined, not replaced (checked with hooks: the hooks of every file ran), and an item that is
//     already there is not added twice (docs; not observable)
//   - any other value is replaced by the higher precedence (checked: model, an env value)
//   - a value of another type replaces whatever was there
//
// merge(files) takes [{ source, data }] in any order, and gives
//   { tree, entries, sources }
//   tree     the merged settings as plain data
//   entries  one per leaf: { path, value, source, shadowed: [{ source, value }] } for a plain value,
//            { path, value, items: [{ value, source, also }] } for an array, { path, value } for an empty object
import { setOwn } from "./jsonc.mjs";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
}

// nodes: { type: "object", children: Map, replaced: [] } | { type: "array", items, replaced } | { type: "value", value, source, shadowed }
function toNode(value, source, replaced) {
  if (isPlain(value)) {
    const node = { type: "object", children: new Map(), replaced };
    for (const [k, v] of Object.entries(value)) node.children.set(k, toNode(v, source, []));
    return node;
  }
  if (Array.isArray(value)) {
    const node = { type: "array", items: [], replaced };
    for (const v of value) addItem(node, v, source);
    return node;
  }
  return { type: "value", value, source, shadowed: replaced };
}

function addItem(node, value, source) {
  const have = node.items.find((i) => same(i.value, value));
  if (have) { if (!have.also.includes(source) && have.source !== source) have.also.push(source); return; }
  node.items.push({ value, source, also: [] });
}

// what a node held, for the list of values a higher file shadowed
function held(node) {
  if (node.type === "value") return [{ source: node.source, value: node.value }, ...node.shadowed];
  return [...node.replaced, { source: sourceOfNode(node), value: valueOfNode(node) }];
}

function sourceOfNode(node) {
  if (node.type === "value") return node.source;
  const first = node.type === "array" ? node.items[0] : [...node.children.values()][0];
  return first ? (first.source !== undefined ? first.source : sourceOfNode(first)) : null;
}

function mergeNode(node, value, source) {
  if (node === undefined) return toNode(value, source, []);
  if (isPlain(value) && node.type === "object") {
    for (const [k, v] of Object.entries(value)) node.children.set(k, mergeNode(node.children.get(k), v, source));
    return node;
  }
  if (Array.isArray(value) && node.type === "array") {
    for (const v of value) addItem(node, v, source);
    return node;
  }
  // a plain value over a plain value, or a value of another type: the new one replaces the old
  return toNode(value, source, held(node));
}

function valueOfNode(node) {
  if (node.type === "value") return node.value;
  if (node.type === "array") return node.items.map((i) => i.value);
  const out = {};
  for (const [k, c] of node.children) setOwn(out, k, valueOfNode(c));
  return out;
}

function flatten(node, path, out) {
  if (node.type === "value") {
    out.push({ path, value: node.value, source: node.source, shadowed: node.shadowed });
  } else if (node.type === "array") {
    out.push({ path, value: valueOfNode(node), items: node.items.map((i) => ({ value: i.value, source: i.source, also: i.also })), shadowed: node.replaced });
  } else if (node.children.size === 0) {
    if (path.length) out.push({ path, value: {}, source: sourceOfNode(node), shadowed: node.replaced });
  } else {
    for (const [k, c] of node.children) flatten(c, [...path, k], out);
  }
}

/**
 * Merge files. `files` is [{ source, data }]; sources compare by `rank` (a higher rank wins). A source is
 * any object with { rank } (the files of settings.mjs are).
 */
export function merge(files) {
  const ordered = [...files].filter((f) => isPlain(f.data)).sort((a, b) => a.source.rank - b.source.rank);
  let root = { type: "object", children: new Map(), replaced: [] };
  for (const f of ordered) root = mergeNode(root, f.data, f.source);
  const entries = [];
  flatten(root, [], entries);
  return { tree: valueOfNode(root), entries, sources: ordered.map((f) => f.source) };
}

/** The entries at or below a key path. */
export function entriesUnder(entries, keyPath) {
  return entries.filter((e) => keyPath.every((k, i) => e.path[i] === k || String(e.path[i]) === String(k)));
}
