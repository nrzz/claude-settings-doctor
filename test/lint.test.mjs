// The lint: what it says about each kind of mistake (the table in lint-table.mjs), where it says it, what Claude
// Code is said to do about it, and what remains of a file once Claude Code has dropped what it drops.
import { world, tmpDir } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadSettings } from "../src/settings.mjs";
import { formatPath, lintFile, lintSettings, locate, parsePath } from "../src/lint.mjs";
import { buildLint } from "../src/commands.mjs";
import { ROWS } from "./lint-table.mjs";

const sig = (f) => `${f.severity} ${f.id} ${f.effect} ${f.path}`;

function lintWorld(w) {
  const s = loadSettings({ project: w.work, env: w.env, home: w.home, managed: w.managedDir });
  return lintSettings(s);
}
const userFile = (r) => r.files.find((f) => f.scope === "user");

test("every row of the table: the findings are the ones listed, no more", () => {
  const w = world("table");
  for (const row of ROWS) {
    w.user(row.file);
    const found = userFile(lintWorld(w)).findings.map(sig).sort();
    assert.deepEqual(found, [...row.expect].sort(), row.name);
  }
});

test("the table is not empty and every row has a name, a file, what lint says and what the doctor said", () => {
  assert.ok(ROWS.length >= 80);
  assert.equal(new Set(ROWS.map((r) => r.name)).size, ROWS.length, "names are unique");
  for (const r of ROWS) {
    assert.ok(r.name && r.file !== undefined && Array.isArray(r.expect) && Array.isArray(r.doctor), r.name);
  }
});

test("a finding says where: file, line, column, key path", () => {
  const w = world("where");
  w.user('{\n  "model": 5,\n  "notAKey": 1,\n  "permissions": {\n    "allow": [\n      "Bash(ls)",\n      7\n    ]\n  }\n}\n');
  const f = userFile(lintWorld(w)).findings;
  const at = (id) => f.find((x) => x.id === id);
  assert.equal(at("wrong-type").line, 2);
  assert.equal(at("wrong-type").path, "model");
  assert.equal(at("unknown-key").line, 3, "the key, not its value");
  assert.equal(at("unknown-key").column, 3);
  const rule = f.find((x) => x.path === "permissions.allow[1]");
  assert.equal(rule.line, 7);
  assert.equal(rule.file, w.userFile);
  assert.equal(rule.scope, "user");
  assert.deepEqual(rule.keyPath, ["permissions", "allow", 1]);
});

test("a comment or a trailing comma says which line, and says what Claude Code does", () => {
  const w = world("syntax");
  w.user('{\n  // one\n  "model": "m", // two\n  "env": {"A": "1",},\n}\n');
  const f = userFile(lintWorld(w)).findings;
  assert.equal(f.length, 2);
  const comment = f.find((x) => /comment/.test(x.message));
  assert.match(comment.message, /2 comments \(\/\/\).*lines 2, 3/);
  assert.match(comment.message, /Claude Code ignores the whole file: none of its settings apply/);
  assert.match(comment.message, /Invalid or malformed JSON/);
  assert.match(comment.fix, /settings\.jsonc/);
  const comma = f.find((x) => /trailing comma/.test(x.message));
  assert.match(comma.message, /2 trailing commas.*line 4/);
});

test("a mistake that is not a comment or a comma says where and how", () => {
  const w = world("syntax2");
  w.user("{\n  'model': 'm'\n}\n");
  const f = userFile(lintWorld(w)).findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].id, "invalid-json");
  assert.equal(f[0].line, 2);
  assert.match(f[0].message, /single quotes are not JSON/);
});

test("unknown keys: a suggestion for a typo, and a caution when there is none", () => {
  const w = world("unknown");
  w.user({ permisions: {}, cleanupPeriodDay: 5, zzzzzzzz: 1 });
  const f = userFile(lintWorld(w)).findings;
  assert.match(f.find((x) => x.path === "permisions").message, /Did you mean "permissions"\?/);
  assert.deepEqual(f.find((x) => x.path === "permisions").suggestions, ["permissions"]);
  assert.match(f.find((x) => x.path === "cleanupPeriodDay").message, /Did you mean "cleanupPeriodDays"\?/);
  assert.match(f.find((x) => x.path === "zzzzzzzz").message, /may lag a release/);
  for (const x of f) assert.match(x.message, /Claude Code ignores keys it does not know, without a word/);
  for (const x of f) assert.match(x.message, /downloaded 2026-\d\d-\d\d/);
});

test("a deprecated key quotes the schema's advice", () => {
  const w = world("dep");
  w.user({ includeCoAuthoredBy: true, env: { ANTHROPIC_SMALL_FAST_MODEL: "x" } });
  const f = userFile(lintWorld(w)).findings;
  assert.match(f.find((x) => x.path === "includeCoAuthoredBy").message, /deprecated: Use 'attribution' instead\./);
  assert.match(f.find((x) => x.path === "env.ANTHROPIC_SMALL_FAST_MODEL").message, /deprecated: prefer ANTHROPIC_DEFAULT_HAIKU_MODEL\./);
});

test("env values that are not strings: what Claude Code makes of each", () => {
  const w = world("env");
  w.user({ env: { A: 1, B: true, C: null, D: [1, 2], E: { x: 1 }, F: 1.5 } });
  const f = userFile(lintWorld(w)).findings;
  const msg = (k) => f.find((x) => x.path === `env.${k}`).message;
  assert.match(msg("A"), /is a number; Claude Code turns it into the string "1"/);
  assert.match(msg("B"), /string "true"/);
  assert.match(msg("C"), /string "null"/);
  assert.match(msg("D"), /string "1,2"/);
  assert.match(msg("E"), /string "\[object Object\]", which is probably not what you meant/);
  assert.match(msg("F"), /string "1\.5"/);
});

test("hooks: the words say what Claude Code does with each kind of mistake", () => {
  const w = world("hookwords");
  w.user({ hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "x", timeout: "10" }] }],
    Stop: [{ matcher: 5, hooks: [] }],
    SessionStarts: [],
    PreToolUse: [{ hooks: [{ type: "command" }] }],
  } });
  const f = userFile(lintWorld(w)).findings;
  const by = (p) => f.find((x) => x.path === p).message;
  assert.match(by("hooks.SessionStart[0].hooks[0].timeout"), /should be a number, found a string\. Claude Code ignores this entry: it never runs/);
  assert.match(by("hooks.Stop[0].matcher"), /Claude Code ignores this group: its hooks never run/);
  assert.match(by("hooks.SessionStarts"), /is not a hook event\. Claude Code ignores it.*Did you mean "SessionStart"\?/);
  assert.match(by("hooks.PreToolUse[0].hooks[0].command"), /Claude Code ignores the whole file: a PreToolUse hook that cannot be loaded may be what guards your permissions/);
});

test("a hook type that is misspelt lists the valid types, and the near one first", () => {
  const w = world("hooktype");
  w.user({ hooks: { Stop: [{ hooks: [{ type: "comand", command: "x" }] }] } });
  const f = userFile(lintWorld(w)).findings[0];
  assert.match(f.message, /Did you mean "command"\? The types are command, prompt, agent, http, mcp_tool\./);
  assert.deepEqual(f.suggestions, ["command"]);
});

test("an invalid regular expression as a matcher is said to match nothing", () => {
  const w = world("matcher");
  w.user({ hooks: { SessionStart: [{ matcher: "[", hooks: [{ type: "command", command: "x" }] }] } });
  const f = userFile(lintWorld(w)).findings[0];
  assert.equal(f.id, "hook-matcher");
  assert.match(f.message, /never matches it, so the hooks in this group never run, and says nothing/);
});

// ---- what remains of a file ------------------------------------------------------------------------------------

test("effective data: a file with a wrong type is ignored whole, with the reason", () => {
  const w = world("eff1");
  w.user({ model: 5, env: { A: "1" } });
  const u = userFile(lintWorld(w));
  assert.equal(u.effective.data, null);
  assert.match(u.effective.ignored.reason, /model should be a string/);
});

test("effective data: a file with a comment is ignored whole", () => {
  const w = world("eff2");
  w.user('{\n// c\n"env": {"A": "1"}}');
  const u = userFile(lintWorld(w));
  assert.equal(u.effective.data, null);
  assert.equal(u.effective.ignored.reason, "it has a comment");
});

test("effective data: a bad hook entry, group, event and field are dropped, the rest stays", () => {
  const w = world("eff3");
  w.user({
    model: "m",
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "ok" }, { type: "command", command: "bad", timeout: "10" }] },
        { matcher: 5, hooks: [{ type: "command", command: "dropped with its group" }] },
        { hooks: [{ type: "command", command: "ok2" }] },
      ],
      Stop: {},
      SessionStarts: [{ hooks: [] }],
    },
    allowedMcpServers: "x",
    permissions: { allow: ["Bash(ls)", 5, "Bash(pwd)"] },
    env: { N: 1 },
  });
  const u = userFile(lintWorld(w));
  assert.equal(u.effective.ignored, null);
  assert.deepEqual(u.effective.data, {
    model: "m",
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "ok" }] }, { hooks: [{ type: "command", command: "ok2" }] }] },
    permissions: { allow: ["Bash(ls)", "Bash(pwd)"] },
    env: { N: "1" },
  });
});

test("effective data: a bad entry under PreToolUse or PermissionRequest ignores the whole file", () => {
  const w = world("eff4");
  w.user({ model: "m", hooks: { PermissionRequest: [{ hooks: [{ type: "command" }] }] } });
  const u = userFile(lintWorld(w));
  assert.equal(u.effective.data, null);
  assert.match(u.effective.ignored.reason, /hooks\.PermissionRequest\[0\]\.hooks\[0\]/);
});

test("effective data never changes what was loaded", () => {
  const w = world("eff5");
  w.user({ env: { N: 1 }, permissions: { allow: [5, "Bash(ls)"] } });
  const s = loadSettings({ project: w.work, env: w.env, home: w.home, managed: w.managedDir });
  const before = JSON.stringify(s.files.find((f) => f.scope === "user").analysis.data);
  lintSettings(s);
  assert.equal(JSON.stringify(s.files.find((f) => f.scope === "user").analysis.data), before);
});

// ---- several files ---------------------------------------------------------------------------------------------

test("each file is linted on its own, with its own scope and display path", () => {
  const w = world("multi");
  w.user({ model: 5 });
  w.project({ notAKey: 1 });
  w.local('{\n// c\n}');
  w.managedSettings({ includeCoAuthoredBy: true });
  const r = lintWorld(w);
  const by = (scope) => r.files.filter((f) => f.scope === scope && f.exists).flatMap((f) => f.findings.map(sig));
  assert.deepEqual(by("user"), ["error wrong-type file model"]);
  assert.deepEqual(by("project"), ["warning unknown-key key notAKey"]);
  assert.deepEqual(by("local"), ["error invalid-json file (the whole file)"]);
  assert.deepEqual(by("managed"), ["warning deprecated none includeCoAuthoredBy"]);
  assert.equal(r.counts.error, 2);
  assert.equal(r.counts.warning, 2);
  assert.deepEqual(r.findings.map((f) => f.severity), ["error", "error", "warning", "warning"], "errors first");
});

test("a settings file that cannot be read is an error, not a crash", () => {
  const w = world("unreadable");
  fs.mkdirSync(w.userFile, { recursive: true }); // a folder where the file should be
  const u = userFile(lintWorld(w));
  assert.equal(u.findings.length, 1);
  assert.equal(u.findings[0].id, "unreadable");
  assert.match(u.findings[0].message, /cannot be read/);
});

test("nothing found is no findings, and a folder with no settings files is not an error", () => {
  const w = world("none");
  const r = lintWorld(w);
  assert.deepEqual(r.findings, []);
  assert.ok(r.files.every((f) => !f.exists));
});

// ---- settings.jsonc beside settings.json -----------------------------------------------------------------------

test("settings.jsonc that settings.json is behind is said to be: edits there are not in effect", () => {
  const w = world("drift");
  w.user({ model: "old" });
  fs.writeFileSync(path.join(w.claude, "settings.jsonc"), '{\n  // changed\n  "model": "new"\n}\n');
  const f = userFile(lintWorld(w)).findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].id, "jsonc-out-of-date");
  assert.equal(f[0].severity, "warning");
  assert.match(f[0].message, /Claude Code reads settings\.json only/);
});

test("settings.jsonc that builds to the same settings in another layout is a note", () => {
  const w = world("drift2");
  w.user('{"model":"m"}');
  fs.writeFileSync(path.join(w.claude, "settings.jsonc"), '{\n  "model": "m"\n}\n');
  const f = userFile(lintWorld(w)).findings;
  assert.deepEqual(f.map(sig), ["note jsonc-out-of-date none (the whole file)"]);
});

test("settings.jsonc that settings.json already matches says nothing; one that cannot be built is said not to reach settings.json", () => {
  const w = world("drift3");
  w.user({ model: "m" });
  fs.writeFileSync(path.join(w.claude, "settings.jsonc"), '{\n  // c\n  "model": "m"\n}\n');
  assert.deepEqual(userFile(lintWorld(w)).findings, []);
  fs.writeFileSync(path.join(w.claude, "settings.jsonc"), '{\n  "model": "m",\n  "model": "n"\n}\n');
  const f = userFile(lintWorld(w)).findings;
  assert.equal(f.length, 1);
  assert.match(f[0].message, /cannot be built.*written twice.*does not reach settings\.json/);
});

test("settings.jsonc with no settings.json is reported on the file that is missing", () => {
  const w = world("drift4");
  fs.writeFileSync(path.join(w.claude, "settings.jsonc"), '{"model": "m"}\n');
  const u = userFile(lintWorld(w));
  assert.equal(u.exists, false);
  assert.match(u.findings[0].message, /settings\.jsonc exists but settings\.json does not/);
});

// ---- lint --file -----------------------------------------------------------------------------------------------

test("--file lints one file; a .jsonc may have comments and commas, and is still held to the schema", () => {
  const w = world("file");
  const f = path.join(w.base, "x.jsonc");
  fs.writeFileSync(f, '{\n  // note\n  "model": 5,\n  "env": {"A": "1",},\n}\n');
  const r = buildLint({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, file: f });
  assert.deepEqual(r.findings.map(sig), ["error wrong-type file model"]);
  assert.equal(r.findings[0].line, 3);
  const bad = path.join(w.base, "y.jsonc");
  fs.writeFileSync(bad, '{"a": }');
  assert.deepEqual(buildLint({ project: w.work, env: w.env, home: w.home, file: bad }).findings.map((x) => x.id), ["invalid-json"]);
  const json = path.join(w.base, "z.json");
  fs.writeFileSync(json, '{\n// c\n"model": "m"}');
  assert.deepEqual(buildLint({ project: w.work, env: w.env, home: w.home, file: json }).findings.map((x) => x.id), ["invalid-json"]);
  const missing = buildLint({ project: w.work, env: w.env, home: w.home, file: path.join(w.base, "nope.json") });
  assert.match(missing.error, /cannot be read/);
  assert.equal(missing.counts.error, 1);
});

// ---- helpers ---------------------------------------------------------------------------------------------------

test("formatPath and parsePath are each other's reverse", () => {
  const cases = [[["hooks", "PreToolUse", 0, "hooks", 1, "timeout"], "hooks.PreToolUse[0].hooks[1].timeout"], [["env", "A_B"], "env.A_B"], [["enabledPlugins", "a@b.c"], 'enabledPlugins["a@b.c"]'], [[], "(the whole file)"]];
  for (const [segments, text] of cases) {
    assert.equal(formatPath(segments), text);
    if (segments.length) assert.deepEqual(parsePath(text), segments);
  }
  assert.deepEqual(parsePath("hooks.PreToolUse.0.matcher"), ["hooks", "PreToolUse", "0", "matcher"]);
  assert.deepEqual(parsePath("a[*].b"), ["a", "*", "b"]);
});

test("locate finds the offset of a value or a key, as far as the text goes", () => {
  const text = '{"a": {"b": [10, {"c": 1}]}}';
  const tree = lintFile({ scope: "user", path: "/x", display: "x", text, analysis: null }, {});
  void tree;
  const w = world("locate");
  w.user(text);
  const s = loadSettings({ project: w.work, env: w.env, home: w.home, managed: w.managedDir });
  const root = s.files.find((f) => f.scope === "user").analysis.parse.root;
  assert.equal(text[locate(root, ["a", "b", 0])], "1");
  assert.equal(text.slice(locate(root, ["a", "b", 1, "c"], "key"), locate(root, ["a", "b", 1, "c"], "key") + 3), '"c"');
  assert.equal(text[locate(root, ["a", "zzz"])], "{", "as far as it goes: the object that holds the missing key");
  assert.equal(locate(root, []), 0);
});

test("the messages are plain: no emoji, no superlatives", () => {
  const w = world("plain");
  const all = [];
  for (const row of ROWS) { w.user(row.file); all.push(...userFile(lintWorld(w)).findings.map((f) => f.message + (f.fix || ""))); }
  for (const m of all) {
    assert.doesNotMatch(m, /[\u{1F300}-\u{1FAFF}☀-➿]/u, m);
    assert.doesNotMatch(m, /\b(simply|just|easily|powerful|amazing|blazing|seamless)\b/i, m);
    assert.ok(m.length < 520, `${m.length} characters: ${m}`);
  }
});

test("a throwaway folder under a path with spaces and non-ASCII letters works", () => {
  const base = tmpDir("csd space ü-");
  const cfg = path.join(base, "my config");
  const proj = path.join(base, "pröject one");
  fs.mkdirSync(cfg, { recursive: true });
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "settings.json"), '{"model": 5}');
  fs.writeFileSync(path.join(proj, ".claude", "settings.json"), '{"zzz": 1}');
  const s = loadSettings({ project: proj, env: { CLAUDE_CONFIG_DIR: cfg, CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR: path.join(base, "none") }, home: base });
  const r = lintSettings(s);
  assert.deepEqual(r.findings.map((f) => f.id).sort(), ["unknown-key", "wrong-type"]);
});
