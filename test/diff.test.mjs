// diff: what changed between two settings values as a list of operations, and applying such a list.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { applyOp, describeOp, diffValues, getAt, same } from "../src/diff.mjs";
import { formatPath } from "../src/lint.mjs";
import { mutate, randomValue, rng } from "./gen.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Lists are compared as sets, so the random values must not repeat an item.
const dedupe = (v) => {
  if (Array.isArray(v)) return v.map(dedupe).filter((x, i, all) => all.findIndex((y) => same(x, y)) === i);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dedupe(x)]));
  return v;
};
const apply = (data, ops) => ops.reduce((acc, op) => applyOp(acc, op), data);

test("same: scalars, types, key order, nesting", () => {
  assert.ok(same(1, 1) && same("a", "a") && same(null, null) && same(true, true));
  assert.ok(!same(1, "1") && !same(0, false) && !same(null, 0) && !same(null, undefined));
  assert.ok(!same([], {}) && !same({}, []) && !same([1], { 0: 1 }));
  assert.ok(same({ a: 1, b: 2 }, { b: 2, a: 1 }), "the order of keys does not matter");
  assert.ok(!same([1, 2], [2, 1]), "the order of items does");
  assert.ok(same({ a: [{ b: [1, { c: null }] }] }, { a: [{ b: [1, { c: null }] }] }));
  assert.ok(!same({ a: 1 }, { b: 1 }) && !same({ a: 1 }, { a: 1, b: 2 }));
});

test("getAt reads a key path, and says undefined for anything that is not there", () => {
  const data = { a: { b: [10, { c: "x" }] }, n: null };
  assert.equal(getAt(data, ["a", "b", 1, "c"]), "x");
  assert.deepEqual(getAt(data, []), data);
  assert.equal(getAt(data, ["a", "zzz"]), undefined);
  assert.equal(getAt(data, ["n", "x"]), undefined);
  assert.equal(getAt(data, ["a", "b", 7]), undefined);
  assert.equal(getAt({}, ["__proto__"]), undefined, "an inherited property is not there");
  assert.equal(getAt({ s: "abc" }, ["s", "length"]), undefined, "a string has no keys");
});

test("diffValues: a key added, a key removed, a value changed", () => {
  assert.deepEqual(diffValues({ a: 1 }, { a: 1, b: 2 }), [{ op: "add", path: ["b"], value: 2 }]);
  assert.deepEqual(diffValues({ a: 1, b: 2 }, { a: 1 }), [{ op: "remove", path: ["b"], value: 2 }]);
  assert.deepEqual(diffValues({ a: 1 }, { a: 2 }), [{ op: "change", path: ["a"], from: 1, to: 2 }]);
  assert.deepEqual(diffValues({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }), [{ op: "change", path: ["a", "b", "c"], from: 1, to: 2 }]);
  assert.deepEqual(diffValues({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffValues({}, {}), []);
});

test("diffValues: a value of another type is a change, not a set of edits", () => {
  assert.deepEqual(diffValues({ a: { b: 1 } }, { a: "s" }), [{ op: "change", path: ["a"], from: { b: 1 }, to: "s" }]);
  assert.deepEqual(diffValues({ a: [1] }, { a: { x: 1 } }), [{ op: "change", path: ["a"], from: [1], to: { x: 1 } }]);
  assert.deepEqual(diffValues({ a: null }, { a: {} }), [{ op: "change", path: ["a"], from: null, to: {} }]);
  assert.deepEqual(diffValues(1, 2), [{ op: "change", path: [], from: 1, to: 2 }]);
});

test("diffValues: lists are sets of items; order and repeats carry no meaning", () => {
  assert.deepEqual(diffValues({ l: ["a", "b"] }, { l: ["b", "a"] }), []);
  assert.deepEqual(diffValues({ l: ["a", "a", "b"] }, { l: ["b", "a"] }), []);
  assert.deepEqual(diffValues({ l: ["a"] }, { l: ["a", "b"] }), [{ op: "item-add", path: ["l"], value: "b" }]);
  assert.deepEqual(diffValues({ l: ["a", "b"] }, { l: ["a"] }), [{ op: "item-remove", path: ["l"], value: "b" }]);
  assert.deepEqual(diffValues({ l: [{ x: 1 }] }, { l: [{ x: 1 }, { x: 2 }] }), [{ op: "item-add", path: ["l"], value: { x: 2 } }]);
  const both = diffValues({ l: ["a", "b"] }, { l: ["b", "c"] });
  assert.deepEqual(both.map((o) => `${o.op} ${o.value}`).sort(), ["item-add c", "item-remove a"]);
});

test("diffValues: a key called __proto__ is a key", () => {
  const a = JSON.parse('{"__proto__": {"x": 1}}');
  const b = JSON.parse('{"__proto__": {"x": 2}}');
  assert.deepEqual(diffValues(a, b), [{ op: "change", path: ["__proto__", "x"], from: 1, to: 2 }]);
  assert.equal(({}).x, undefined);
  const out = applyOp(a, { op: "change", path: ["__proto__", "x"], from: 1, to: 2 });
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(out, "__proto__").value.x, 2);
});

test("applyOp: each operation, on a copy", () => {
  const data = { a: 1, l: ["x"], o: { k: "v" } };
  const frozen = JSON.stringify(data);
  assert.deepEqual(applyOp(data, { op: "add", path: ["b"], value: 2 }), { a: 1, l: ["x"], o: { k: "v" }, b: 2 });
  assert.deepEqual(applyOp(data, { op: "remove", path: ["a"], value: 1 }), { l: ["x"], o: { k: "v" } });
  assert.deepEqual(applyOp(data, { op: "change", path: ["o", "k"], from: "v", to: "w" }), { a: 1, l: ["x"], o: { k: "w" } });
  assert.deepEqual(applyOp(data, { op: "item-add", path: ["l"], value: "y" }).l, ["x", "y"]);
  assert.deepEqual(applyOp(data, { op: "item-add", path: ["l"], value: "x" }).l, ["x"], "an item that is there is not added twice");
  assert.deepEqual(applyOp(data, { op: "item-remove", path: ["l"], value: "x" }).l, []);
  assert.deepEqual(applyOp(data, { op: "item-remove", path: ["l"], value: "zzz" }).l, ["x"]);
  assert.equal(JSON.stringify(data), frozen, "the input is never changed");
});

test("applyOp: objects on the way are created for an add, and a missing path is left alone for a remove", () => {
  assert.deepEqual(applyOp({}, { op: "add", path: ["a", "b", "c"], value: 1 }), { a: { b: { c: 1 } } });
  assert.deepEqual(applyOp({ a: 5 }, { op: "add", path: ["a", "b"], value: 1 }), { a: { b: 1 } }, "a scalar in the way is replaced");
  assert.deepEqual(applyOp({}, { op: "remove", path: ["a", "b"], value: 1 }), {});
  assert.deepEqual(applyOp({ a: 1 }, { op: "item-remove", path: ["x", "y"], value: 1 }), { a: 1 });
  assert.deepEqual(applyOp({}, { op: "item-add", path: ["p", "allow"], value: "r" }), { p: { allow: ["r"] } }, "a list is made when there is none");
  assert.deepEqual(applyOp({ a: 1 }, { op: "change", path: [], from: { a: 1 }, to: { z: 1 } }), { z: 1 });
});

test("describeOp: one short line for each operation, long values cut", () => {
  assert.equal(describeOp({ op: "add", path: ["model"], value: "m" }, formatPath), '+ model = "m"');
  assert.equal(describeOp({ op: "remove", path: ["env", "A"], value: "1" }, formatPath), '- env.A (was "1")');
  assert.equal(describeOp({ op: "change", path: ["a"], from: 1, to: 2 }, formatPath), "~ a: 1 -> 2");
  assert.equal(describeOp({ op: "item-add", path: ["permissions", "allow"], value: "Bash(ls)" }, formatPath), '+ permissions.allow item "Bash(ls)"');
  assert.equal(describeOp({ op: "item-remove", path: ["hooks", "Stop", 0], value: 1 }, formatPath), "- hooks.Stop[0] item 1");
  const long = describeOp({ op: "add", path: ["x"], value: "y".repeat(500) }, formatPath);
  assert.ok(long.length < 100 && long.endsWith('..."') === false && long.includes("..."), long);
});

test("2,000 random pairs: applying the operations of diffValues(a, b) to a gives b", () => {
  const r = rng(77);
  for (let n = 0; n < 2000; n++) {
    const a = dedupe({ model: "m", ...randomValue(r) });
    const b = r() < 0.2 ? dedupe({ model: "n", ...randomValue(r) }) : mutate(a, r);
    const ops = diffValues(a, b);
    const got = apply(a, ops);
    assert.deepEqual(diffValues(got, b), [], `${JSON.stringify(a)} -> ${JSON.stringify(b)} gave ${JSON.stringify(got)}`);
  }
});

test("a value that differs gives operations, and a copy of a value gives none, for 500 random values", () => {
  const r = rng(5);
  for (let n = 0; n < 500; n++) {
    const a = dedupe({ k: "v", ...randomValue(r) });
    assert.deepEqual(diffValues(a, structuredClone(a)), []);
    const b = mutate(a, r, { steps: 1 });
    if (!same(a, b)) assert.ok(diffValues(a, b).length > 0, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
});
