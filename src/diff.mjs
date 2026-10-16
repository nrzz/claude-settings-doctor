// What changed between two settings values, as a list of operations, and applying such a list to data.
//
//   { op: "add", path, value }          a key that was not there
//   { op: "remove", path, value }       a key that is gone (value: what it held)
//   { op: "change", path, from, to }    a value, or a value of another type, replaced
//   { op: "item-add", path, value }     an item added to the list at path
//   { op: "item-remove", path, value }  an item taken out of the list at path
//
// Lists are compared as sets of items (order is ignored): Claude Code joins lists and drops repeats, so the
// order of permission rules or hooks carries no meaning.
import { setOwn } from "./jsonc.mjs";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => own(b, k) && same(a[k], b[k]));
}

// The value with every list a sorted set (the items in one order, none twice) and the keys of every object sorted.
const asSet = (v) => (Array.isArray(v) ? [...new Set(v.map(asSet).map((x) => JSON.stringify(x)))].sort().map((x) => JSON.parse(x)) : isPlain(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, asSet(v[k])])) : v);

/**
 * Whether two settings values hold the same settings: lists are sets to Claude Code, so the same items in another
 * order, or one of them twice, are the same, inside the items of a list too; and the order of keys does not matter.
 */
export const sameSettings = (a, b) => JSON.stringify(asSet(a)) === JSON.stringify(asSet(b));

/** The value at a key path, or undefined. */
export function getAt(data, keyPath) {
  let v = data;
  for (const k of keyPath) {
    if (v === null || typeof v !== "object" || !own(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

/** The operations that turn `a` into `b`. */
export function diffValues(a, b, keyPath = [], out = []) {
  if (isPlain(a) && isPlain(b)) {
    for (const k of Object.keys(a)) if (!own(b, k)) out.push({ op: "remove", path: [...keyPath, k], value: a[k] });
    for (const k of Object.keys(b)) {
      if (!own(a, k)) out.push({ op: "add", path: [...keyPath, k], value: b[k] });
      else diffValues(a[k], b[k], [...keyPath, k], out);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const dedupe = (list) => list.filter((x, i) => list.findIndex((y) => same(x, y)) === i);
    const da = dedupe(a);
    const db = dedupe(b);
    for (const x of da) if (!db.some((y) => same(x, y))) out.push({ op: "item-remove", path: keyPath, value: x });
    for (const y of db) if (!da.some((x) => same(x, y))) out.push({ op: "item-add", path: keyPath, value: y });
    return out;
  }
  if (!same(a, b)) out.push({ op: "change", path: keyPath, from: a, to: b });
  return out;
}

/** A copy of `data` with one operation applied. Creates the objects on the way for an add. */
export function applyOp(data, op) {
  const copy = structuredClone(data);
  if (op.path.length === 0) return op.op === "change" ? structuredClone(op.to) : copy;
  let parent = copy;
  for (let i = 0; i < op.path.length - 1; i++) {
    const k = op.path[i];
    if (!own(parent, k) || parent[k] === null || typeof parent[k] !== "object") {
      if (op.op === "remove" || op.op === "item-remove") return copy;
      setOwn(parent, k, {});
    }
    parent = parent[k];
  }
  const last = op.path[op.path.length - 1];
  switch (op.op) {
    case "add": setOwn(parent, last, structuredClone(op.value)); break;
    case "remove": delete parent[last]; break;
    case "change": setOwn(parent, last, structuredClone(op.to)); break;
    case "item-add":
    case "item-remove": {
      const list = own(parent, last) ? parent[last] : undefined;
      if (op.op === "item-add") {
        if (Array.isArray(list)) { if (!list.some((x) => same(x, op.value))) list.push(structuredClone(op.value)); } else setOwn(parent, last, [structuredClone(op.value)]);
      } else if (Array.isArray(list)) {
        const at = list.findIndex((x) => same(x, op.value));
        if (at >= 0) list.splice(at, 1);
      }
      break;
    }
    default:
  }
  return copy;
}

/** A short text for an operation, for reports: +permissions.allow "Bash(ls)", ~model "a" -> "b", -theme. */
export function describeOp(op, format) {
  const at = format(op.path);
  const j = (v) => { const t = JSON.stringify(v); return t.length > 70 ? `${t.slice(0, 67)}...` : t; };
  switch (op.op) {
    case "add": return `+ ${at} = ${j(op.value)}`;
    case "remove": return `- ${at} (was ${j(op.value)})`;
    case "change": return `~ ${at}: ${j(op.from)} -> ${j(op.to)}`;
    case "item-add": return `+ ${at} item ${j(op.value)}`;
    case "item-remove": return `- ${at} item ${j(op.value)}`;
    default: return at;
  }
}
