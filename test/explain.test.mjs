// explain <key>: what the schema says about a key, and which files set it now, and what Claude Code does with them.
import { run, world } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildExplain } from "../src/commands.mjs";

const ask = (w, key) => buildExplain({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, key });

test("a key with a description, a type and a default; set in no file, so the default is what Claude Code uses", async () => {
  const w = world("explain-default");
  const m = ask(w, "cleanupPeriodDays");
  assert.equal(m.found, true);
  assert.equal(m.type, "integer");
  assert.equal(m.default, 30);
  assert.equal(m.hasDefault, true);
  assert.match(m.description, /^Number of days to retain sessions/);
  assert.deepEqual(m.setBy, []);
  assert.equal(m.winner, null);
  const r = await run(["explain", "cleanupPeriodDays"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /^cleanupPeriodDays {3}integer, default 30\n/);
  assert.match(r.out, /Set in no settings file, so Claude Code uses its default \(30\)\./);
  assert.match(r.out, /From SchemaStore's schema, downloaded 2026-\d\d-\d\d; Claude Code can know more or less\./);
});

test("a key with a list of allowed values says them", async () => {
  const w = world("explain-enum");
  const m = ask(w, "permissions.defaultMode");
  assert.ok(m.enum.includes("acceptEdits") && m.enum.includes("plan") && m.enum.includes("default"));
  const r = await run(["explain", "permissions.defaultMode"], w);
  assert.match(r.out, /\nAllowed: "acceptEdits", /);
  assert.match(r.out, /^permissions\.defaultMode {3}one of "acceptEdits"/);
});

test("which file sets it: the highest wins a value, the others are shadowed", async () => {
  const w = world("explain-set", { user: { model: "u" }, project: { model: "p" }, local: { model: "l" } });
  const m = ask(w, "model");
  assert.deepEqual(m.setBy.map((s) => [s.scope, s.value, s.ignored]), [["local", "l", null], ["project", "p", null], ["user", "u", null]]);
  assert.equal(m.winner.scope, "local");
  assert.equal(m.combine, "replace");
  const r = await run(["explain", "model"], w);
  assert.match(r.out, /Set now in:\n {2}local\s+\.claude\/settings\.local\.json\s+"l"\s+<- wins\n {2}project\s+\.claude\/settings\.json\s+"p"\s+\(shadowed\)\n {2}user\s+~\/\.claude\/settings\.json\s+"u"\s+\(shadowed\)/);
});

test("lists are joined and objects merge key by key, so no file wins them", async () => {
  const w = world("explain-combine", { user: { permissions: { allow: ["Bash(a)"] }, env: { A: "1" } }, project: { permissions: { allow: ["Bash(b)"] }, env: { B: "2" } } });
  const list = ask(w, "permissions.allow");
  assert.equal(list.combine, "join");
  assert.deepEqual(list.merged.items.map((i) => i.value), ["Bash(a)", "Bash(b)"]);
  const obj = ask(w, "env");
  assert.equal(obj.combine, "merge");
  const r = await run(["explain", "permissions.allow"], w);
  assert.match(r.out, /\(joined with the others\)/);
  assert.match(r.out, /Claude Code joins the items of all the files: 2 in all\./);
  assert.doesNotMatch(r.out, /<- wins/);
  assert.match((await run(["explain", "env"], w)).out, /\(merged key by key with the others\)/);
  const single = world("explain-single", { user: { permissions: { allow: ["Bash(a)"] } } });
  const one = await run(["explain", "permissions.allow"], single);
  assert.doesNotMatch(one.out, /joined with the others|wins|shadowed/, "one file: nothing to say about the others");
});

test("a file Claude Code ignores is shown with its value and the reason, and does not win", async () => {
  const w = world("explain-ignored", { user: { model: "u" } });
  w.write(w.projectFile, '{\n  // my pick\n  "model": "p"\n}\n');
  const m = ask(w, "model");
  assert.deepEqual(m.setBy.map((s) => [s.scope, s.value, s.ignored]), [["project", "p", "it has a comment"], ["user", "u", null]]);
  assert.equal(m.winner.scope, "user", "the highest file that Claude Code reads");
  const r = await run(["explain", "model"], w);
  assert.match(r.out, /project\s+\.claude\/settings\.json\s+"p"\s+\(Claude Code ignores this file: it has a comment\)/);
  assert.match(r.out, /user\s+~\/\.claude\/settings\.json\s+"u"\s+<- wins/);
});

test("a key inside a list, written with a dot or a bracket, a name the schema takes any of, and a nested key", async () => {
  const w = world("explain-paths", { user: { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x", timeout: 5 }] }] } } });
  for (const key of ["hooks.PreToolUse[0].matcher", "hooks.PreToolUse.0.matcher"]) {
    const m = ask(w, key);
    assert.equal(m.found, true, key);
    assert.equal(m.type, "string");
    assert.equal(m.setBy[0].value, "Bash", key);
  }
  assert.equal(ask(w, "hooks.PreToolUse[0].hooks[0].timeout").setBy[0].value, 5);
  assert.equal(ask(w, "env.MY_OWN_VARIABLE").found, true, "any name is a string in env");
  assert.equal(ask(w, "sandbox.network.allowedDomains").found, true);
  assert.equal(ask(w, "enabledPlugins").found, true);
});

test("a key the schema does not know: a near one is suggested, and the first part it does not know is named", async () => {
  const w = world("explain-unknown");
  const typo = await run(["explain", "cleanupPeriodDay"], w);
  assert.equal(typo.code, 1);
  assert.match(typo.out, /^cleanupPeriodDay is not in the schema \(SchemaStore, downloaded 2026-\d\d-\d\d\)\.\nDid you mean "cleanupPeriodDays"\?\n$/);
  const deep = await run(["explain", "permisions.defalutMode"], w);
  assert.equal(deep.code, 1);
  assert.match(deep.out, /The first part the schema does not know is "permisions"\.\nDid you mean "permissions"\?/);
  const nested = await run(["explain", "permissions.defalutMode"], w);
  assert.match(nested.out, /Did you mean "defaultMode"\?/);
  assert.doesNotMatch(nested.out, /The first part/, "the typo is in the last part, which the line already shows");
  const far = await run(["explain", "zzzzzzzz"], w);
  assert.match(far.out, /Claude Code ignores keys it does not know, without a word\. If this one is new, the schema may lag a release\./);
  assert.equal(far.code, 1);
  const j = ask(w, "permisions.defalutMode");
  assert.deepEqual([j.found, j.unknown, j.unknownAt, j.suggestions], [false, "permisions", 0, ["permissions"]]);
});

test("a deprecated key says so and what to use", async () => {
  const w = world("explain-deprecated", { user: { includeCoAuthoredBy: false } });
  const m = ask(w, "includeCoAuthoredBy");
  assert.equal(m.deprecated, "Use 'attribution' instead.");
  const r = await run(["explain", "includeCoAuthoredBy"], w);
  assert.match(r.out, /^includeCoAuthoredBy {3}boolean, default true\ndeprecated: Use 'attribution' instead\.\n/);
});

test("an object lists its keys, a long list is cut", async () => {
  const w = world("explain-children");
  const m = ask(w, "sandbox.network");
  assert.ok(m.children.includes("allowedDomains"));
  assert.match((await run(["explain", "sandbox.network"], w)).out, /\nKeys: .*allowedDomains/);
  const hooks = ask(w, "hooks");
  assert.ok(hooks.children.includes("PreToolUse") && hooks.children.includes("SessionStart"));
  assert.ok(hooks.children.length <= 60);
});

test("no key, or an empty one, is said, not guessed at", () => {
  const w = world("explain-empty");
  assert.match(ask(w, "").error, /give a key, such as cleanupPeriodDays or permissions\.defaultMode/);
  assert.equal(ask(w, "").found, false);
});

test("explain --json: the same document the text is made of, without the loaded files", async () => {
  const w = world("explain-json", { user: { model: "u" } });
  const j = (await run(["explain", "model", "--json"], w)).json();
  assert.equal(j.found, true);
  assert.equal(j.path, "model");
  assert.deepEqual(j.keyPath, ["model"]);
  assert.equal(j.winner.scope, "user");
  assert.equal(j.schema.source, "https://json.schemastore.org/claude-code-settings.json");
  assert.equal(j.settings, undefined);
});

test("explain reads the files of the project it is given", async () => {
  const w = world("explain-project", { project: { model: "here" } });
  const other = world("explain-elsewhere", { project: { model: "there" } });
  const r = await run(["explain", "model", "--json", "--project", other.work], w);
  assert.equal(r.json().winner.value, "there");
});
