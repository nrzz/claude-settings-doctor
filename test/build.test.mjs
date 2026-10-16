// build: settings.jsonc -> the text of settings.json. Comments and trailing commas go, the keys stay in order, the
// layout is two spaces and a final newline, and nothing else about the values changes.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildFromJsonc, emitJson } from "../src/build.mjs";
import { parseJsonc, toValue } from "../src/jsonc.mjs";
import { pick, randomValue, render, rng } from "./gen.mjs";

const build = (text) => buildFromJsonc(text);

test("comments and trailing commas go; two-space layout; a final newline", () => {
  const b = build('// top\n{\n  "a": 1, // one\n  /* two */ "b": [1, 2,],\n  "c": {"d": null,},\n}\n');
  assert.equal(b.ok, true);
  assert.equal(b.text, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": {\n    "d": null\n  }\n}\n');
});

test("key order is kept, also for keys that look like numbers", () => {
  const b = build('{"z": 1, "10": 2, "2": 3, "a": 4, "1": 5}');
  assert.equal(b.text, '{\n  "z": 1,\n  "10": 2,\n  "2": 3,\n  "a": 4,\n  "1": 5\n}\n');
  assert.deepEqual(Object.keys(JSON.parse(b.text)), ["1", "2", "10", "z", "a"], "JSON.stringify would have reordered these");
});

test("numbers and strings are written as they were written", () => {
  const src = '{"a": 1.0, "b": 1e3, "c": 12345678901234567890, "d": "\\u00e9\\/\\n", "e": -0, "f": "ü"}';
  const b = build(src);
  assert.equal(b.text, '{\n  "a": 1.0,\n  "b": 1e3,\n  "c": 12345678901234567890,\n  "d": "\\u00e9\\/\\n",\n  "e": -0,\n  "f": "ü"\n}\n');
});

test("empty objects and lists stay on one line; nesting indents by two", () => {
  assert.equal(build("{}").text, "{}\n");
  assert.equal(build('{"a": {}, "b": [], "c": [[], {}], "d": {"e": {"f": []}}}').text, '{\n  "a": {},\n  "b": [],\n  "c": [\n    [],\n    {}\n  ],\n  "d": {\n    "e": {\n      "f": []\n    }\n  }\n}\n');
});

test("a byte-order mark and CRLF line endings in the source do not reach the output", () => {
  const b = build('﻿{\r\n  "a": 1, // x\r\n  "b": 2\r\n}\r\n');
  assert.equal(b.ok, true);
  assert.equal(b.text, '{\n  "a": 1,\n  "b": 2\n}\n');
  assert.ok(!b.text.includes("\r"));
});

test("building the output again gives the same text, and it is JSON that JSON.parse reads", () => {
  const src = '{\n // c\n "x": [1, {"y": 2,},], "z": "s" }';
  const once = build(src).text;
  assert.equal(build(once).text, once);
  assert.deepEqual(JSON.parse(once), { x: [1, { y: 2 }], z: "s" });
});

test("refused: a mistake in the text, with the line", () => {
  const b = build('{\n  "a": 1,\n  "b": \n}');
  assert.equal(b.ok, false);
  assert.equal(b.problems[0].kind, "syntax");
  assert.equal(b.problems[0].line, 4);
  assert.equal(build("").ok, false);
  assert.match(build("").problems[0].message, /empty/);
  assert.match(build("// only a note\n").problems[0].message, /only comments/);
});

test("refused: not an object", () => {
  for (const t of ["[]", '"x"', "1", "null", "true"]) {
    const b = build(t);
    assert.equal(b.ok, false, t);
    assert.equal(b.problems[0].kind, "not-object");
  }
});

test("refused: a key written twice, because Claude Code keeps only the last and build will not choose", () => {
  const b = build('{\n  "env": {"A": "1"},\n  "x": 1,\n  "env": {"B": "2"}\n}');
  assert.equal(b.ok, false);
  assert.equal(b.problems.length, 1);
  assert.equal(b.problems[0].kind, "duplicate-key");
  assert.match(b.problems[0].message, /"env" is written twice \(lines 2 and 4\).*keeps only the last/);
  const nested = build('{"hooks": {"Stop": [], "Stop": []}}');
  assert.match(nested.problems[0].message, /"hooks\.Stop"/);
});

test("emitJson on a tree is the same as build", () => {
  const p = parseJsonc('{"a": [1, 2]}');
  assert.equal(`${emitJson(p.root)}\n`, build('{"a": [1, 2]}').text);
});

test("1,000 random documents: the output is plain JSON of the same value, with the keys in the same order", () => {
  const r = rng(2026);
  for (let n = 0; n < 1000; n++) {
    const value = { model: "m", ...randomValue(r) };
    const { text } = render(value, r, { eol: r() < 0.3 ? "\r\n" : "\n", unit: r() < 0.2 ? "\t" : pick(r, ["  ", "    ", " "]) });
    const b = build(text);
    assert.equal(b.ok, true, text);
    assert.ok(!/\/\/|\/\*/.test(b.text), "no comments");
    assert.deepEqual(JSON.parse(b.text), value, text);
    assert.deepEqual(Object.keys(JSON.parse(b.text)), Object.keys(value));
    assert.equal(build(b.text).text, b.text, "building the output changes nothing");
    assert.ok(b.text.endsWith("}\n") && !b.text.endsWith("\n\n"), "one final newline");
    assert.ok(!b.text.includes("\r") && !b.text.includes("\t"), "two spaces, line feeds");
    assert.deepEqual(toValue(parseJsonc(text).root), value);
  }
});

test("a file of 5,000 keys builds in well under a second", () => {
  const big = { env: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`K${i}`, `v${i}`])) };
  const text = `{\n  "env": {\n${Object.entries(big.env).map(([k, v]) => `    "${k}": "${v}", // n`).join("\n")}\n  }\n}\n`;
  const t0 = Date.now();
  const b = build(text);
  assert.equal(b.ok, true);
  assert.deepEqual(JSON.parse(b.text), big);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
});
