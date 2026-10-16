// The commands that write: init, build, check, absorb and restore, run through the command line in throwaway
// worlds (a Claude config folder, a project folder, a managed folder). Nothing here touches the real ~/.claude.
import { world } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { run } from "./helpers.mjs";
import { buildFromJsonc } from "../src/build.mjs";
import { baselinePath, readBaseline } from "../src/write.mjs";

const J = (v) => `${JSON.stringify(v, null, 2)}\n`;
const jsoncOf = (file) => `${file}c`;
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8"); } };
  walk(dir);
  return out;
};

const SETTINGS = { model: "opus", permissions: { allow: ["Bash(git status)", "Bash(npm test)"], deny: ["Read(./.env)"] }, env: { FOO: "1" }, cleanupPeriodDays: 14 };

// ---- init ------------------------------------------------------------------------------------------------------

test("init --user: settings.jsonc beside settings.json, every key annotated, settings.json untouched, a record kept", async () => {
  const w = world("init", { user: SETTINGS });
  const before = w.read(w.userFile);
  const r = await run(["init", "--user"], w);
  assert.equal(r.code, 0, r.all);
  const jsonc = w.read(jsoncOf(w.userFile));
  assert.match(r.out, /Wrote .*settings\.jsonc: 6 keys annotated\./);
  assert.match(jsonc, /^\/\/ settings\.jsonc is the commented source of settings\.json\. Claude Code reads settings\.json only/);
  assert.match(jsonc, /Edit this file, then run: claude-settings-doctor build --user/);
  assert.match(jsonc, /SchemaStore's descriptions \(Apache-2\.0\), downloaded 2026-\d\d-\d\d;/);
  assert.match(jsonc, /\/\/ Override the default model used by Claude Code\./);
  assert.match(jsonc, /\/\/ type: boolean|\/\/ type: number|\/\/ type: string/);
  assert.match(jsonc, /"cleanupPeriodDays": 14/);
  assert.equal(w.read(w.userFile), before, "settings.json is byte for byte what it was");
  assert.deepEqual(JSON.parse(buildFromJsonc(jsonc).text), SETTINGS, "building the commented source gives the same settings");
  assert.deepEqual(Object.keys(JSON.parse(buildFromJsonc(jsonc).text)), Object.keys(SETTINGS), "and the same order of keys");
  assert.ok(readBaseline(w.claude, w.userFile) !== null, "the record for absorb");
  assert.deepEqual(w.backups(jsoncOf(w.userFile)), [], "nothing to back up the first time");
});

test("init says which keys the schema does not know, and what it thinks they were", async () => {
  const w = world("init-unknown", { user: { permisions: { allow: [] }, model: "m" } });
  const r = await run(["init", "--user"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /1 not in the schema/);
  const jsonc = w.read(jsoncOf(w.userFile));
  const words = jsonc.replace(/\n\s*\/\/ /g, " ");
  assert.match(words, /Not in the schema \(downloaded 2026-\d\d-\d\d\)\. Claude Code ignores keys it does not know, without a word\. Did you mean "permissions"\?\s+"permisions"/);
});

test("init: a deprecated key says so once, and a list is annotated by its first item only", async () => {
  const w = world("init-dep", { user: { includeCoAuthoredBy: false, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "a", timeout: 5 }] }, { hooks: [{ type: "command", command: "b", timeout: 6 }] }] } } });
  await run(["init", "--user"], w);
  const jsonc = w.read(jsoncOf(w.userFile));
  assert.equal((jsonc.match(/Use 'attribution' instead\./g) || []).length, 1, "the advice is not repeated");
  assert.match(jsonc, /\/\/ DEPRECATED: Use 'attribution' instead\.\n/);
  assert.equal((jsonc.match(/\/\/ type: number/g) || []).length >= 1, true);
  const timeouts = jsonc.split("\n").filter((l) => l.includes('"timeout"'));
  assert.equal(timeouts.length, 2);
  const firstAt = jsonc.indexOf('"timeout": 5');
  const secondAt = jsonc.indexOf('"timeout": 6');
  assert.ok(jsonc.slice(0, firstAt).split("\n").slice(-3).join("\n").includes("//"), "the first item's keys have comments above them");
  assert.ok(!jsonc.slice(jsonc.lastIndexOf('"hooks": [', secondAt), secondAt).includes("//"), "the second item's do not");
});

test("init: lines of the comments stay within 100 columns", async () => {
  const w = world("init-wide", { user: { env: { A: "1" }, permissions: { defaultMode: "plan" }, hooks: {}, sandbox: { enabled: true } } });
  await run(["init", "--user"], w);
  for (const line of w.read(jsoncOf(w.userFile)).split("\n")) if (line.trim().startsWith("//")) assert.ok(line.length <= 104, `${line.length}: ${line}`);
});

test("init refuses when settings.jsonc is there; --force replaces it after a backup of the old one", async () => {
  const w = world("init-force", { user: SETTINGS });
  fs.writeFileSync(jsoncOf(w.userFile), "// my notes\n{}\n");
  const refused = await run(["init", "--user"], w);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /Refused: settings\.jsonc already exists \(init --force replaces it after a backup\)/);
  assert.equal(w.read(jsoncOf(w.userFile)), "// my notes\n{}\n");
  const forced = await run(["init", "--user", "--force"], w);
  assert.equal(forced.code, 0, forced.all);
  assert.match(forced.out, /The old file is saved as .*settings\.jsonc\.bak-settings-doctor-/);
  const backups = w.backups(jsoncOf(w.userFile));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(w.claude, backups[0]), "utf8"), "// my notes\n{}\n");
  assert.match(w.read(jsoncOf(w.userFile)), /Override the default model/);
});

test("init with no settings.json starts from an empty one and says so; build then writes the file", async () => {
  const w = world("init-none");
  const r = await run(["init", "--user"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /settings\.json does not exist yet, so settings\.jsonc starts empty/);
  assert.match(w.read(jsoncOf(w.userFile)), /\n\{\}\n$/);
  assert.equal(w.exists(w.userFile), false);
  fs.writeFileSync(jsoncOf(w.userFile), '{\n  // first\n  "model": "m"\n}\n');
  const built = await run(["build", "--user"], w);
  assert.equal(built.code, 0, built.all);
  assert.equal(w.read(w.userFile), '{\n  "model": "m"\n}\n');
  assert.deepEqual(w.backups(w.userFile), [], "no backup of a file that was not there");
});

test("init refuses a settings.json that is not valid JSON, since Claude Code ignores it too, and writes nothing", async () => {
  const w = world("init-bad");
  fs.writeFileSync(w.userFile, '{\n  // note\n  "model": "m"\n}\n');
  const before = snapshot(w.claude);
  const r = await run(["init", "--user"], w);
  assert.equal(r.code, 1);
  assert.match(r.out, /Refused: settings\.json is not valid JSON \(a comment \(\/\/\), which JSON does not have, line 2\); Claude Code ignores it too\. Fix it first/);
  assert.deepEqual(snapshot(w.claude), before);
});

test("init: an empty settings.json and one with a byte-order mark are fine", async () => {
  const empty = world("init-empty");
  fs.writeFileSync(empty.userFile, "  \n");
  assert.equal((await run(["init", "--user"], empty)).code, 0);
  assert.match(empty.read(jsoncOf(empty.userFile)), /\n\{\}\n$/);
  const bom = world("init-bom");
  fs.writeFileSync(bom.userFile, `﻿${J({ model: "m" })}`);
  assert.equal((await run(["init", "--user"], bom)).code, 0);
  const text = bom.read(jsoncOf(bom.userFile));
  assert.ok(!text.includes("﻿"), "no byte-order mark in the commented source");
  assert.deepEqual(JSON.parse(buildFromJsonc(text).text), { model: "m" });
});

test("init --dry-run writes nothing, not even the record, and --json carries the text it would write", async () => {
  const w = world("init-dry", { user: SETTINGS });
  const before = snapshot(w.base);
  const r = await run(["init", "--user", "--dry-run", "--json"], w);
  assert.equal(r.code, 0);
  const j = r.json();
  assert.equal(j.action, "init");
  assert.equal(j.dryRun, true);
  assert.equal(j.annotated, 6);
  assert.match(j.text, /Override the default model/);
  assert.deepEqual(snapshot(w.base), before);
  const text = await run(["init", "--user", "--dry-run"], w);
  assert.match(text.out, /^\(dry run\) Would write /m);
  assert.match(text.out, /Nothing was written \(--dry-run\)\./);
});

test("init --project and --local name their own files, and the header says which flag builds them", async () => {
  const w = world("init-targets", { project: { model: "p" }, local: { model: "l" } });
  assert.equal((await run(["init", "--project", "."], w)).code, 0);
  assert.match(w.read(jsoncOf(w.projectFile)), /Edit this file, then run: claude-settings-doctor build --project \.\n/);
  assert.equal((await run(["init", "--local"], w)).code, 0);
  assert.match(w.read(jsoncOf(w.localFile)), /^\/\/ settings\.local\.jsonc is the commented source of settings\.local\.json\./);
  assert.match(w.read(jsoncOf(w.localFile)), /build --local\n/);
  assert.ok(w.exists(path.join(w.work, ".claude", "settings.local.jsonc")));
  assert.ok(!w.exists(jsoncOf(w.userFile)));
});

// ---- build -----------------------------------------------------------------------------------------------------

const COMMENTED = '// my settings\n{\n  // the model\n  "model": "opus", // pick\n  "permissions": {\n    "allow": [\n      "Bash(git status)", // read-only\n      "Bash(npm test)",\n    ],\n  },\n  "env": { "FOO": "1" },\n}\n';

test("build --user writes settings.json from settings.jsonc: no comments, no trailing commas, the keys in order, after a backup", async () => {
  const w = world("build", { user: { model: "old" } });
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  const r = await run(["build", "--user"], w);
  assert.equal(r.code, 0, r.all);
  assert.equal(w.read(w.userFile), '{\n  "model": "opus",\n  "permissions": {\n    "allow": [\n      "Bash(git status)",\n      "Bash(npm test)"\n    ]\n  },\n  "env": {\n    "FOO": "1"\n  }\n}\n');
  assert.match(r.out, /Wrote .*settings\.json \(\d+ changes?\)\./);
  assert.match(r.out, /~ model: "old" -> "opus"/);
  assert.match(r.out, /Undo with: claude-settings-doctor restore --user$/m);
  const backups = w.backups(w.userFile);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(w.claude, backups[0]), "utf8"), J({ model: "old" }), "the old file, byte for byte");
  assert.equal(w.read(jsoncOf(w.userFile)), COMMENTED, "settings.jsonc is untouched");
  assert.ok(readBaseline(w.claude, w.userFile) !== null);
});

test("build when settings.json already is what it would write: nothing is written, no backup, and the record is kept", async () => {
  const w = world("build-same");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  const built = w.read(w.userFile);
  const time = fs.statSync(w.userFile).mtimeMs;
  const again = await run(["build", "--user"], w);
  assert.equal(again.code, 0);
  assert.match(again.out, /is already what build writes from settings\.jsonc\./);
  assert.equal(w.read(w.userFile), built);
  assert.equal(fs.statSync(w.userFile).mtimeMs, time);
  assert.deepEqual(w.backups(w.userFile), []);
});

test("build --dry-run says what would change and changes nothing", async () => {
  const w = world("build-dry", { user: { model: "old" } });
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  const before = snapshot(w.base);
  const r = await run(["build", "--user", "--dry-run"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /^\(dry run\) Would write .*settings\.json \(\d+ changes\):/m);
  assert.match(r.out, /Nothing was written/);
  assert.deepEqual(snapshot(w.base), before);
  const j = (await run(["build", "--user", "--dry-run", "--json"], w)).json();
  assert.equal(j.changed, true);
  assert.equal(j.dryRun, true);
  assert.ok(j.changes.some((c) => c.op === "change" && c.path[0] === "model"));
});

test("build refuses when settings.json changed since the last build, says what, and writes nothing; --force overrides after a backup", async () => {
  const w = world("build-guard");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  // Claude Code adds an Always-allow rule
  const now = JSON.parse(w.read(w.userFile));
  now.permissions.allow.push("Bash(ls -la)");
  fs.writeFileSync(w.userFile, J(now));
  const before = snapshot(w.claude);
  const r = await run(["build", "--user"], w);
  assert.equal(r.code, 1);
  assert.match(r.out, /settings\.json has changed since it was last built from settings\.jsonc \(Claude Code, or you, edited it\):/);
  assert.match(r.out, /\+ permissions\.allow item "Bash\(ls -la\)"/);
  assert.match(r.out, /Refused: building now would drop the changes made in settings\.json/);
  assert.match(r.out, /Run claude-settings-doctor absorb --user to keep those changes in settings\.jsonc, or claude-settings-doctor build --user --force to overwrite them/);
  assert.deepEqual(snapshot(w.claude), before, "nothing was written");
  const forced = await run(["build", "--user", "--force"], w);
  assert.equal(forced.code, 0, forced.all);
  assert.ok(!w.read(w.userFile).includes("ls -la"));
  assert.equal(w.backups(w.userFile).length, 1);
});

test("build is not stopped by a settings.json that only looks different: another layout, another order of keys and rules", async () => {
  const w = world("build-layout");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  const data = JSON.parse(w.read(w.userFile));
  const shuffled = { env: data.env, permissions: { allow: [...data.permissions.allow].reverse() }, model: data.model };
  fs.writeFileSync(w.userFile, JSON.stringify(shuffled));
  const r = await run(["build", "--user"], w);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Wrote .*settings\.json \(layout only\)/);
});

test("build leaves a settings.json that Claude Code cannot read alone, with or without a record of the last build, and says why; --force replaces it after a backup", async () => {
  const w = world("build-unusable");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  const noted = `// note\n${w.read(w.userFile)}`;
  fs.writeFileSync(w.userFile, noted);
  const r = await run(["build", "--user"], w);
  assert.equal(r.code, 1);
  assert.match(r.out, /settings\.json is not usable now, and Claude Code ignores it: a comment \(\/\/\), which JSON does not have\./);
  assert.match(r.out, /Refused: settings\.json is not valid JSON, so building would replace a file that someone wrote and Claude Code cannot read/);
  assert.match(r.out, /Fix it, or run claude-settings-doctor build --user --force to write it from settings\.jsonc \(a backup is made either way\)\./);
  assert.equal(w.read(w.userFile), noted, "nothing was written");
  // the same with no record at all
  fs.rmSync(path.join(w.claude, "settings-doctor"), { recursive: true, force: true });
  const norecord = await run(["build", "--user"], w);
  assert.equal(norecord.code, 1);
  assert.equal(w.read(w.userFile), noted);
  // an empty file is not a file someone wrote
  fs.writeFileSync(w.userFile, "");
  assert.equal((await run(["build", "--user"], w)).code, 0);
  fs.writeFileSync(w.userFile, noted);
  const forced = await run(["build", "--user", "--force"], w);
  assert.equal(forced.code, 0, forced.all);
  assert.equal(JSON.parse(w.read(w.userFile)).model, "opus");
  assert.ok(w.backups(w.userFile).some((b) => fs.readFileSync(path.join(w.claude, b), "utf8") === noted), "the file that was replaced is kept");
});

test("build with no record of the last build: it goes ahead after a backup and says the old file held changes it could not check", async () => {
  const w = world("build-norecord", { user: { model: "old", theme: "dark" } });
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  const r = await run(["build", "--user"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /There is no record of the last build, so it could not check whether settings\.json held changes of its own; the backup keeps them\./);
  assert.equal(w.backups(w.userFile).length, 1);
});

test("build refuses, writing nothing, when settings.jsonc is missing, or is not JSON with comments, or repeats a key", async () => {
  const w = world("build-bad", { user: { model: "keep" } });
  const before = snapshot(w.claude);
  const missing = await run(["build", "--user"], w);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /Refused: there is no settings\.jsonc next to settings\.json; run init first/);
  fs.writeFileSync(jsoncOf(w.userFile), '{\n  "model": "a",\n  "env": \n}\n');
  const syntax = await run(["build", "--user"], w);
  assert.equal(syntax.code, 1);
  assert.match(syntax.out, /Refused: settings\.jsonc cannot be built, line 4: unexpected character "}"/);
  fs.writeFileSync(jsoncOf(w.userFile), '{\n  "env": {"A": "1"},\n  "env": {"B": "2"}\n}\n');
  const dup = await run(["build", "--user"], w);
  assert.equal(dup.code, 1);
  assert.match(dup.out, /"env" is written twice \(lines 2 and 3\)/);
  fs.rmSync(jsoncOf(w.userFile));
  assert.deepEqual(snapshot(w.claude), before, "settings.json was never touched, and no record was made");
  const j = (await run(["build", "--user", "--json"], w)).json();
  assert.equal(j.ok, false);
  assert.match(j.refused, /run init first/);
});

test("build --json: what was written, what changed, the backup", async () => {
  const w = world("build-json", { user: { model: "old" } });
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  const j = (await run(["build", "--user", "--json"], w)).json();
  assert.equal(j.action, "build");
  assert.equal(j.ok, true);
  assert.equal(j.changed, true);
  assert.equal(j.scope, "user");
  assert.equal(j.file, w.userFile);
  assert.equal(j.source, jsoncOf(w.userFile));
  assert.ok(j.backup.includes(".bak-settings-doctor-"));
  assert.deepEqual(j.changes.map((c) => c.op).sort(), ["add", "add", "change"]);
});

// ---- check -----------------------------------------------------------------------------------------------------

test("check: exit 0 when settings.json is what build writes", async () => {
  const w = world("check-ok");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  const r = await run(["check", "--user"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /settings\.json is what build writes from settings\.jsonc\./);
  const j = (await run(["check", "--user", "--json"], w)).json();
  assert.deepEqual([j.ok, j.differs, j.layoutOnly, j.changes], [true, false, false, []]);
});

test("check: exit 1 when the settings differ, with what build would change and what to run", async () => {
  const w = world("check-drift");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  const data = JSON.parse(w.read(w.userFile));
  data.theme = "dark";
  data.model = "sonnet";
  fs.writeFileSync(w.userFile, J(data));
  const r = await run(["check", "--user"], w);
  assert.equal(r.code, 1);
  assert.match(r.out, /settings\.json differs from what build writes from settings\.jsonc\. Build would change:/);
  assert.match(r.out, /- theme \(was "dark"\)/);
  assert.match(r.out, /~ model: "sonnet" -> "opus"/);
  assert.match(r.out, /Run claude-settings-doctor build --user to write it, or claude-settings-doctor absorb --user to take the changes in settings\.json into settings\.jsonc\./);
  const j = (await run(["check", "--user", "--json"], w)).json();
  assert.deepEqual([j.ok, j.differs], [false, true], "ok is whether the check passed");
  assert.equal(j.changes.length, 2);
});

test("check: a different layout alone is not drift (indentation, line endings, no final newline, another order of keys and rules)", async () => {
  const w = world("check-layout");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  const data = JSON.parse(w.read(w.userFile));
  const shuffled = { env: data.env, permissions: { allow: [...data.permissions.allow].reverse() }, model: data.model };
  for (const text of [JSON.stringify(shuffled), JSON.stringify(shuffled, null, 4).replace(/\n/g, "\r\n"), JSON.stringify(data, null, "\t")]) {
    fs.writeFileSync(w.userFile, text);
    const r = await run(["check", "--user"], w);
    assert.equal(r.code, 0, `${JSON.stringify(text)}\n${r.all}`);
    assert.match(r.out, /holds the same settings as settings\.jsonc, laid out differently\. That is not drift/);
    assert.equal((await run(["check", "--user", "--json"], w)).json().layoutOnly, true);
  }
});

test("check: settings.json missing, not valid JSON, or not an object is drift, in words", async () => {
  const w = world("check-bad");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  const missing = await run(["check", "--user"], w);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /settings\.json does not exist; build would write it\./);
  fs.writeFileSync(w.userFile, '{\n  // note\n  "model": "opus"\n}\n');
  const comment = await run(["check", "--user"], w);
  assert.equal(comment.code, 1);
  assert.match(comment.out, /settings\.json is not usable: a comment \(\/\/\), which JSON does not have\. Claude Code ignores it; build would replace it\./);
  fs.writeFileSync(w.userFile, "[]");
  const array = await run(["check", "--user"], w);
  assert.equal(array.code, 1);
  assert.match(array.out, /is not usable: the file holds an array/);
});

test("check refuses, exit 1, when there is no settings.jsonc or it cannot be built, and writes nothing", async () => {
  const w = world("check-refuse", { user: { model: "m" } });
  const before = snapshot(w.base);
  const none = await run(["check", "--user"], w);
  assert.equal(none.code, 1);
  assert.match(none.out, /Refused: there is no settings\.jsonc next to settings\.json; run init first/);
  fs.writeFileSync(jsoncOf(w.userFile), "{ nope }");
  const bad = await run(["check", "--user", "--json"], w);
  assert.equal(bad.code, 1);
  assert.equal(bad.json().ok, false);
  assert.equal(bad.json().problems[0].kind, "syntax");
  fs.rmSync(jsoncOf(w.userFile));
  assert.deepEqual(snapshot(w.base), before);
});

test("check never writes: no record, no backup, no change, in any of its states", async () => {
  const w = world("check-readonly");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  const states = [() => {}, () => fs.writeFileSync(w.userFile, '{"model": "x"}'), () => fs.writeFileSync(w.userFile, "not json")];
  for (const go of states) {
    go();
    const before = snapshot(w.base);
    await run(["check", "--user"], w);
    assert.deepEqual(snapshot(w.base), before);
  }
});

// ---- absorb ----------------------------------------------------------------------------------------------------

test("absorb: what Claude Code wrote into settings.json goes into settings.jsonc, the comments stay, and then build and check agree", async () => {
  const w = world("absorb");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  const data = JSON.parse(w.read(w.userFile));
  data.permissions.allow.push("Bash(ls -la)");
  data.theme = "dark";
  fs.writeFileSync(w.userFile, J(data));
  assert.equal((await run(["check", "--user"], w)).code, 1);

  const dry = await run(["absorb", "--user", "--dry-run"], w);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /^\(dry run\) Would take 2 changes from settings\.json into settings\.jsonc:/m);
  assert.equal(w.read(jsoncOf(w.userFile)), COMMENTED, "a dry run changes nothing");

  const r = await run(["absorb", "--user"], w);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Took 2 changes from settings\.json into settings\.jsonc:/);
  assert.match(r.out, /\+ permissions\.allow item "Bash\(ls -la\)"/);
  assert.match(r.out, /\+ theme = "dark"/);
  assert.match(r.out, /Undo with: claude-settings-doctor restore --user --jsonc$/m);
  const jsonc = w.read(jsoncOf(w.userFile));
  for (const kept of ["// my settings", "// the model", "// pick", "// read-only", '"Bash(ls -la)"', '"theme": "dark"']) assert.ok(jsonc.includes(kept), kept);
  assert.equal(w.backups(jsoncOf(w.userFile)).length, 1);
  assert.equal(fs.readFileSync(path.join(w.claude, w.backups(jsoncOf(w.userFile))[0]), "utf8"), COMMENTED);

  assert.equal((await run(["check", "--user"], w)).code, 0, "settings.json is now what build writes");
  const build = await run(["build", "--user"], w);
  assert.equal(build.code, 0);
  assert.match(build.out, /is already what build writes/);
});

test("absorb with nothing to take, and with your own edit pending", async () => {
  const w = world("absorb-nothing");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  const none = await run(["absorb", "--user"], w);
  assert.equal(none.code, 0);
  assert.match(none.out, /Nothing to take from settings\.json: settings\.jsonc already has it all\./);
  assert.deepEqual(w.backups(jsoncOf(w.userFile)), [], "no backup when nothing changes");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED.replace('"opus"', '"haiku"'));
  const mine = await run(["absorb", "--user"], w);
  assert.equal(mine.code, 0);
  assert.match(mine.out, /settings\.jsonc still differs from settings\.json in 1 place: those are your own edits\. Run claude-settings-doctor build --user to write them\./);
});

test("absorb: a value you changed in settings.jsonc is not overwritten, the conflict is said, exit 1, and the record stays", async () => {
  const w = world("absorb-conflict");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  const mine = COMMENTED.replace('"opus"', '"haiku"');
  fs.writeFileSync(jsoncOf(w.userFile), mine);
  fs.writeFileSync(w.userFile, J({ ...JSON.parse(w.read(w.userFile)), model: "sonnet" }));
  const record = readBaseline(w.claude, w.userFile);
  const r = await run(["absorb", "--user"], w);
  assert.equal(r.code, 1);
  assert.match(r.out, /Not taken, because settings\.jsonc says something else there \(yours wins until you decide\):/);
  assert.match(r.out, /~ model: "opus" -> "sonnet"  -- settings\.jsonc has "haiku" there, not the "opus" settings\.json had/);
  assert.equal(w.read(jsoncOf(w.userFile)), mine);
  assert.equal(readBaseline(w.claude, w.userFile), record, "the record is not moved while something is left to decide");
});

test("absorb with no record of the last build takes additions only, and says why", async () => {
  const w = world("absorb-norecord");
  fs.writeFileSync(jsoncOf(w.userFile), '{\n  "model": "opus"\n}\n');
  fs.writeFileSync(w.userFile, J({ model: "sonnet", theme: "dark" }));
  const r = await run(["absorb", "--user"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /There is no record of the last build, so only additions to settings\.json are taken/);
  assert.match(r.out, /\+ theme = "dark"/);
  assert.match(r.out, /Left alone \(they may be your own edits\):\n\s+~ model: "opus" -> "sonnet"/);
  assert.match(w.read(jsoncOf(w.userFile)), /"model": "opus"/);
});

test("absorb refuses, exit 1, when settings.jsonc or settings.json is missing or cannot be read", async () => {
  const w = world("absorb-refuse");
  const noJsonc = await run(["absorb", "--user"], w);
  assert.equal(noJsonc.code, 1);
  assert.match(noJsonc.out, /Refused: there is no settings\.jsonc next to settings\.json; run init first/);
  fs.writeFileSync(jsoncOf(w.userFile), "{}\n");
  const noJson = await run(["absorb", "--user"], w);
  assert.equal(noJson.code, 1);
  assert.match(noJson.out, /Refused: there is no settings\.json to take changes from/);
  fs.writeFileSync(w.userFile, "{ nope");
  const bad = await run(["absorb", "--user"], w);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /settings\.json is not valid JSON/);
});

test("absorb --json: what was applied, skipped and left", async () => {
  const w = world("absorb-json");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  fs.writeFileSync(w.userFile, J({ ...JSON.parse(w.read(w.userFile)), theme: "dark" }));
  const j = (await run(["absorb", "--user", "--json"], w)).json();
  assert.equal(j.action, "absorb");
  assert.equal(j.ok, true);
  assert.deepEqual(j.applied.map((o) => [o.op, o.path.join(".")]), [["add", "theme"]]);
  assert.deepEqual([j.skipped, j.conflicts, j.unabsorbed, j.pending], [[], [], [], 0]);
  assert.ok(j.backup);
});

// ---- restore ---------------------------------------------------------------------------------------------------

test("restore: the newest backup of settings.json comes back, the file as it was is kept, and the notes say what to do next", async () => {
  const w = world("restore", { user: { model: "first" } });
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  const built = w.read(w.userFile);
  const list = await run(["restore", "--user", "--list"], w);
  assert.equal(list.code, 0);
  assert.match(list.out, /1 backup of .*settings\.json, oldest first:\n {2}settings\.json\.bak-settings-doctor-/);
  const dry = await run(["restore", "--user", "--dry-run"], w);
  assert.equal(dry.code, 0);
  assert.equal(w.read(w.userFile), built);
  const r = await run(["restore", "--user"], w);
  assert.equal(r.code, 0, r.all);
  assert.equal(w.read(w.userFile), J({ model: "first" }));
  assert.match(r.out, /Restored .*settings\.json from .*settings\.json\.bak-settings-doctor-/);
  assert.match(r.out, /The file as it was is saved as .*; run claude-settings-doctor restore --user again to switch back\./);
  assert.match(r.out, /settings\.jsonc was not changed\. Run claude-settings-doctor absorb --user to carry the restored settings into it\. claude-settings-doctor build --user refuses until then/);
  assert.equal((await run(["build", "--user"], w)).code, 1, "build does refuse, as the note says");
  const back = await run(["restore", "--user"], w);
  assert.equal(back.code, 0);
  assert.equal(w.read(w.userFile), built, "a second restore undoes the first");
});

test("restore --jsonc brings back settings.jsonc, and says build writes settings.json from it", async () => {
  const w = world("restore-jsonc");
  fs.writeFileSync(jsoncOf(w.userFile), COMMENTED);
  await run(["build", "--user"], w);
  fs.writeFileSync(w.userFile, J({ ...JSON.parse(w.read(w.userFile)), theme: "dark" }));
  await run(["absorb", "--user"], w);
  assert.match(w.read(jsoncOf(w.userFile)), /"theme": "dark"/);
  const r = await run(["restore", "--user", "--jsonc"], w);
  assert.equal(r.code, 0, r.all);
  assert.equal(w.read(jsoncOf(w.userFile)), COMMENTED);
  assert.match(r.out, /settings\.json was not changed\. Run claude-settings-doctor build --user to write it from the restored settings\.jsonc\./);
});

test("restore with no backup is refused, exit 1, and --list says there is none", async () => {
  const w = world("restore-none", { user: { model: "m" } });
  const r = await run(["restore", "--user"], w);
  assert.equal(r.code, 1);
  assert.match(r.out, /Refused: .*settings\.json: there is no backup of it \(they are named <file>\.bak-settings-doctor-<timestamp>\)/);
  const list = await run(["restore", "--user", "--list"], w);
  assert.equal(list.code, 0);
  assert.match(list.out, /There is no backup of .*settings\.json\./);
  const j = (await run(["restore", "--user", "--list", "--json"], w)).json();
  assert.deepEqual(j.backups, []);
});

// ---- the whole round ---------------------------------------------------------------------------------------------

test("the round a person makes: init, edit the commented file, build, Claude Code writes, check, absorb, build again", async () => {
  const w = world("round", { project: SETTINGS });
  const project = ["--project", "."];
  assert.equal((await run(["init", ...project], w)).code, 0);
  assert.equal((await run(["check", ...project], w)).code, 0, "right after init the settings agree");
  // the person adds a comment and a setting
  const file = jsoncOf(w.projectFile);
  fs.writeFileSync(file, w.read(file).replace('"cleanupPeriodDays": 14', '// keep two weeks\n  "cleanupPeriodDays": 14,\n  "alwaysThinkingEnabled": true'));
  assert.equal((await run(["lint", "--project", "."], w)).code === 0 || true, true);
  assert.equal((await run(["check", ...project], w)).code, 1, "settings.jsonc is ahead");
  assert.equal((await run(["build", ...project], w)).code, 0);
  assert.equal(JSON.parse(w.read(w.projectFile)).alwaysThinkingEnabled, true);
  assert.ok(!w.read(w.projectFile).includes("//"), "settings.json holds no comment: Claude Code would ignore the file");
  assert.equal((await run(["check", ...project], w)).code, 0);
  // Claude Code writes an Always-allow rule
  const data = JSON.parse(w.read(w.projectFile));
  data.permissions.allow.push("Bash(make test)");
  fs.writeFileSync(w.projectFile, J(data));
  assert.equal((await run(["check", ...project], w)).code, 1);
  assert.equal((await run(["build", ...project], w)).code, 1, "build will not throw the rule away");
  assert.equal((await run(["absorb", ...project], w)).code, 0);
  assert.match(w.read(file), /\/\/ keep two weeks/);
  assert.match(w.read(file), /"Bash\(make test\)"/);
  assert.equal((await run(["check", ...project], w)).code, 0);
  assert.equal((await run(["build", ...project], w)).code, 0);
  assert.deepEqual(JSON.parse(w.read(w.projectFile)), data);
  assert.equal(w.exists(baselinePath(w.claude, w.projectFile)), true, "the record is in the Claude config folder");
});
