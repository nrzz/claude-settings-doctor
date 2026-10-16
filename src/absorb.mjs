// absorb: what Claude Code (or you) changed in settings.json, put back into settings.jsonc with its comments.
//
// Without it a settings.jsonc goes stale the first time Claude Code writes settings.json: an "Always allow"
// rule, a /config change. The three texts at hand are
//   settings.json    now
//   settings.jsonc   your source, with comments
//   baseline         settings.json as it was at the last build, absorb or init (kept by src/write.mjs)
// What changed in settings.json is the difference between the baseline and now. Each change is put into
// settings.jsonc as a text edit, but only where settings.jsonc still agrees with the baseline: a value you
// changed yourself since the build is yours, and is reported as a conflict, not overwritten.
// Without a baseline only additions can be told from your own edits, so only additions are taken.
import { applyOp, describeOp, diffValues, getAt, same, sameSettings } from "./diff.mjs";
import { insertItem, insertMember, nodeAtPath, removeElement, replaceValue, styleOf } from "./jsonedit.mjs";
import { parseJsonc, setOwn, toValue } from "./jsonc.mjs";
import { formatPath } from "./lint.mjs";

const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
const nest = (keyPath, value) => keyPath.reduceRight((acc, k) => setOwn({}, k, acc), value);

/**
 * Take the changes in settings.json into settings.jsonc.
 *   jsoncText, jsonText, baselineText (or null)
 * Returns { ok, refused, text, applied, skipped, conflicts, unabsorbed, pending, internal }:
 *   text        the new settings.jsonc (unchanged when nothing applied)
 *   applied     operations put into the text
 *   skipped     operations that needed nothing (settings.jsonc already had it)
 *   conflicts   operations not applied because settings.jsonc differs from the baseline there: { op, reason }
 *   unabsorbed  with no baseline: differences that might be your edits, left alone
 *   pending     how many differences remain between settings.jsonc and settings.json (your own edits, for build)
 */
export function absorb({ jsoncText, jsonText, baselineText }) {
  const out = { ok: false, refused: null, text: jsoncText, applied: [], skipped: [], conflicts: [], unabsorbed: [], pending: 0, internal: null, baseline: baselineText !== null };
  let tree = parseJsonc(jsoncText);
  if (!tree.ok) { out.refused = `settings.jsonc is not valid JSON with comments (${tree.error.message})`; return out; }
  if (tree.root.type !== "object") { out.refused = "settings.jsonc does not hold an object"; return out; }
  if (tree.duplicates.length) { out.refused = `settings.jsonc repeats the key "${tree.duplicates[0].key}"; Claude Code keeps only the last one, so absorb will not choose for you`; return out; }
  let json;
  try { json = JSON.parse(stripBom(jsonText)); } catch (e) { out.refused = `settings.json is not valid JSON (${String(e.message).slice(0, 80)}), so there is nothing to take from it`; return out; }
  if (json === null || typeof json !== "object" || Array.isArray(json)) { out.refused = "settings.json does not hold an object"; return out; }
  let baseline = null;
  if (baselineText !== null) {
    try { baseline = JSON.parse(stripBom(baselineText)); } catch { baseline = null; }
    if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) baseline = null;
  }
  out.baseline = baseline !== null;

  const startData = toValue(tree.root);
  let ops;
  if (baseline) ops = deepestFirst(pairListEdits(diffValues(baseline, json), startData));
  else {
    const all = diffValues(startData, json);
    ops = all.filter((o) => o.op === "add" || o.op === "item-add");
    out.unabsorbed = all.filter((o) => !(o.op === "add" || o.op === "item-add")).map((op) => ({ op, reason: "there is no record of the last build, so it cannot be told from a change you made in settings.jsonc" }));
  }

  let text = jsoncText;
  let cur = startData;
  const st = styleOf(jsoncText);
  const reparse = () => { tree = parseJsonc(text); cur = toValue(tree.root); };

  for (const op of ops) {
    const here = getAt(cur, op.path);
    const done = (kind, reason) => out[kind].push({ op, reason });
    try {
      if (op.op === "add") {
        if (here === undefined) { const next = insertAtPath(text, tree, op.path, op.value, st, done); if (next === null) continue; text = next; }
        else if (same(here, op.value)) { done("skipped", "settings.jsonc has it already"); continue; }
        else { done("conflicts", `settings.jsonc has ${short(here)} there`); continue; }
      } else if (op.op === "remove") {
        if (here === undefined) { done("skipped", "settings.jsonc does not have it"); continue; }
        if (!same(here, op.value)) { done("conflicts", `settings.jsonc has ${short(here)} there, not the ${short(op.value)} settings.json had`); continue; }
        const hit = nodeAtPath(tree.root, op.path);
        text = removeElement(text, hit.parent, hit.parent.members.indexOf(hit.member));
      } else if (op.op === "change") {
        if (same(here, op.to)) { done("skipped", "settings.jsonc has it already"); continue; }
        if (here === undefined) { done("skipped", "settings.jsonc does not have the key"); continue; }
        if (!same(here, op.from)) { done("conflicts", `settings.jsonc has ${short(here)} there, not the ${short(op.from)} settings.json had`); continue; }
        text = replaceValue(text, nodeAtPath(tree.root, op.path).node, op.to, st);
      } else if (op.op === "item-add") {
        if (here === undefined) { const next = insertAtPath(text, tree, op.path, [op.value], st, done); if (next === null) continue; text = next; }
        else if (!Array.isArray(here)) { done("conflicts", `settings.jsonc has ${short(here)} there, not a list`); continue; }
        else if (here.some((x) => same(x, op.value))) { done("skipped", "settings.jsonc has the item already"); continue; }
        else text = insertItem(text, nodeAtPath(tree.root, op.path).node, op.value, st);
      } else if (op.op === "item-remove") {
        if (!Array.isArray(here)) { done("skipped", "settings.jsonc has no such list"); continue; }
        const k = here.findIndex((x) => same(x, op.value));
        if (k < 0) { done("skipped", "settings.jsonc does not have the item"); continue; }
        text = removeElement(text, nodeAtPath(tree.root, op.path).node, k);
      }
    } catch (e) {
      out.internal = `could not apply ${describeOp(op, formatPath)}: ${e.message}`;
      out.text = jsoncText;
      return out;
    }
    out.applied.push({ op });
    reparse();
  }

  // the check: the new text must hold exactly what the applied operations say, and still be valid
  let expected = startData;
  for (const a of out.applied) expected = applyOp(expected, a.op);
  const check = parseJsonc(text);
  if (!check.ok || !same(toValue(check.root), expected)) {
    out.internal = "the edited text did not come out as planned, so nothing was changed";
    out.text = jsoncText;
    out.applied = [];
    return out;
  }
  out.text = text;
  const result = toValue(check.root);
  out.pending = sameSettings(json, result) ? 0 : diffValues(json, result).length;
  out.ok = true;
  return out;
}

const short = (v) => { const t = JSON.stringify(v); return t.length > 40 ? `${t.slice(0, 37)}...` : t; };

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The value with its keys in order, as text: two objects that differ only in the order of keys give the same text.
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v));

// How alike two values are, 0 to 1. Scalars are alike or not. Lists: the items that are alike in both, each item
// counting as far as it is alike its best partner, over all the items of both. Objects: of all the keys either has,
// the sum of how alike the values of the keys both have are, a key both have counting a quarter at least. An empty
// list or object is halfway alike a full one.
function similarity(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (!a.length && !b.length) return 1;
    if (!a.length || !b.length) return 0.5;
    const scored = [];
    a.forEach((x, i) => b.forEach((y, j) => { const s = similarity(x, y); if (s > 0) scored.push({ i, j, s }); }));
    scored.sort((p, q) => q.s - p.s);
    const usedA = new Set();
    const usedB = new Set();
    let together = 0;
    for (const { i, j, s } of scored) {
      if (usedA.has(i) || usedB.has(j)) continue;
      usedA.add(i);
      usedB.add(j);
      together += s;
    }
    return together / (a.length + b.length - together);
  }
  if (isObject(a) && isObject(b)) {
    const names = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (!names.size) return 1;
    if (!Object.keys(a).length || !Object.keys(b).length) return 0.5;
    let points = 0;
    for (const k of names) if (Object.hasOwn(a, k) && Object.hasOwn(b, k)) points += Math.max(0.25, similarity(a[k], b[k]));
    return points / names.size;
  }
  return canon(a) === canon(b) ? 1 : 0;
}

/**
 * A change inside an item of a list (a hook group whose matcher changed, a hook added to a group) comes out of the
 * comparison as the old item removed and a new one added. Written back like that, the old item's comments would go
 * with it and the new item would land at the end of the list. So an item removed and an item added that are alike
 * (see similarity), the likeliest pairs first, are taken as one item that changed: the operations are those between
 * the two, at the old item's place in settings.jsonc (a number in their path is the index there).
 */
function pairListEdits(ops, current) {
  const lists = new Map();
  ops.forEach((op, at) => {
    if ((op.op !== "item-remove" && op.op !== "item-add") || !isObject(op.value)) return;
    const key = JSON.stringify(op.path);
    if (!lists.has(key)) lists.set(key, { path: op.path, removes: [], adds: [] });
    lists.get(key)[op.op === "item-remove" ? "removes" : "adds"].push({ op, at });
  });
  const replaced = new Map(); // the place of an operation -> the operations that stand for it ([] for the one it was paired with)
  for (const { path, removes, adds } of lists.values()) {
    const list = getAt(current, path);
    if (!Array.isArray(list)) continue;
    const pairs = [];
    for (const rem of removes) {
      const index = list.findIndex((x) => same(x, rem.op.value));
      if (index < 0) continue;
      for (const add of adds) pairs.push({ rem, add, index, score: similarity(rem.op.value, add.op.value) });
    }
    pairs.sort((x, y) => y.score - x.score || x.index - y.index);
    const taken = new Set();
    for (const p of pairs) {
      if (p.score <= 0 || taken.has(p.rem) || taken.has(p.add)) continue;
      taken.add(p.rem);
      taken.add(p.add);
      replaced.set(p.rem.at, pairListEdits(diffValues(p.rem.op.value, p.add.op.value, [...path, p.index]), current));
      replaced.set(p.add.at, []);
    }
  }
  if (!replaced.size) return ops;
  return ops.flatMap((op, at) => (replaced.has(at) ? replaced.get(at) : [op]));
}

// An operation that names an item of a list by its place (a number in the path) must come before any operation that
// takes an item out of that list, which moves the items after it. Those that go deepest into lists come first.
const places = (op) => op.path.filter((s) => typeof s === "number").length;
const deepestFirst = (ops) => [...ops].sort((a, b) => places(b) - places(a));

// Add a value at a key path, creating the objects on the way. Returns the new text, or null (and records a
// conflict through `done`) when something of another type is in the way.
function insertAtPath(text, tree, keyPath, value, st, done) {
  let node = tree.root;
  let depth = 0;
  while (depth < keyPath.length) {
    const seg = keyPath[depth];
    if (node.type === "array" && Number.isInteger(seg) && node.items[seg]) { node = node.items[seg]; depth++; continue; }
    if (node.type !== "object") {
      done("conflicts", `settings.jsonc has a value that is not an object at ${formatPath(keyPath.slice(0, depth))}`);
      return null;
    }
    const m = node.members.filter((x) => x.key === seg).pop();
    if (!m) break;
    node = m.value;
    depth++;
  }
  if (depth >= keyPath.length) { done("conflicts", "settings.jsonc has the key already"); return null; }
  return insertMember(text, node, keyPath[depth], nest(keyPath.slice(depth + 1), value), st);
}
