// The reports: show, lint and its short markdown form for the skill, and the lines the writing commands print.
import { run, world } from "./helpers.mjs";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildLint } from "../src/commands.mjs";
import { markdownLint, palette, plural, renderWrite, strip } from "../src/report.mjs";
import { VERSION } from "../src/version.mjs";

test("palette: colour codes when on, the plain text when off", () => {
  const on = palette(true);
  assert.equal(on.red("x"), "\x1b[31mx\x1b[0m");
  assert.equal(on.green("x"), "\x1b[32mx\x1b[0m");
  assert.equal(on.bold("x"), "\x1b[1mx\x1b[0m");
  const off = palette(false);
  for (const name of ["red", "green", "yellow", "blue", "dim", "bold"]) assert.equal(off[name]("x"), "x");
  assert.equal(off.red(5), "5", "a number is made text");
});

test("plural: one, many, and the many that is not a plain s", () => {
  assert.equal(plural(1, "key"), "1 key");
  assert.equal(plural(0, "key"), "0 keys");
  assert.equal(plural(2, "match", "matches"), "2 matches");
});

// ---- show --------------------------------------------------------------------------------------------------------

test("show: the files from the highest down, each in its state, then the merged settings with their files", async () => {
  const w = world("show", {
    user: { model: "u", env: { A: "1", B: "2" }, permissions: { allow: ["Bash(a)", "Bash(b)"] }, notAKey: 1 },
    project: { model: "p", env: { B: "3" }, permissions: { allow: ["Bash(b)", "Bash(c)"] } },
  });
  w.write(w.localFile, '{\n  // my notes\n  "model": "l"\n}\n');
  const r = await run(["show"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`^claude-settings-doctor ${VERSION.replace(/\./g, "\\.")}  the settings Claude Code merges\n`));
  assert.match(r.out, /\nproject {3}.*\nconfig {4}.* {2}\(from CLAUDE_CONFIG_DIR\)\nschema {4}SchemaStore's claude-code-settings\.json, downloaded 2026-\d\d-\d\d\n/);
  const files = r.out.split("Settings files, highest precedence first\n")[1].split("\n\n")[0].split("\n");
  assert.deepEqual(files.map((l) => l.trim().split(/\s+/)[0]), ["managed", "local", "project", "user"], "the order Claude Code gives them");
  assert.match(files[0], /managed-settings\.json\s+not found$/);
  assert.match(files[1], /\.claude\/settings\.local\.json\s+ignored by Claude Code: it has a comment$/);
  assert.match(files[2], /\.claude\/settings\.json\s+read, 3 keys$/);
  assert.match(files[3], /~\/\.claude\/settings\.json\s+read, 4 keys$/);
  assert.match(r.out, /Merged settings \(\d+ values from 2 files; a higher file wins a key, objects merge key by key, lists are joined\)/);
  assert.match(r.out, /\n {2}model\s+"p"\s+project\n {6}shadowed: "u" in user settings \(~\/\.claude\/settings\.json\)\n/);
  assert.match(r.out, /\n {2}env\.A\s+"1"\s+user\n/);
  assert.match(r.out, /\n {2}env\.B\s+"3"\s+project\n {6}shadowed: "2" in user settings/);
  assert.match(r.out, /\n {2}permissions\.allow\s+3 items {2}\(user 2, project 1\)\n/);
  assert.match(r.out, /\n {6}"Bash\(b\)"\s+user \(also project\)\n/, "a rule in two files is one item, with both files named");
  assert.match(r.out, /\n {2}notAKey\s+1\s+user {2}\(not in the schema\)\n/);
  assert.match(r.out, /\n2 keys shadowed\. Findings: 1 error, 1 warning \(run lint\)\./);
  assert.match(r.out, /\nNot read by this tool:\n {2}- server-managed settings, macOS profiles and the Windows registry/);
  assert.match(r.out, /\n {2}- plugin settings: a plugin supplies its own agent and statusLine defaults/);
  assert.match(r.out, /\n {2}- the --settings, --setting-sources and --add-dir flags/);
});

test("show: a file that is empty, one that cannot be read, and no file at all", async () => {
  const w = world("show-states");
  fs.writeFileSync(w.userFile, "  \n");
  fs.mkdirSync(w.projectFile, { recursive: true }); // a folder where the file should be
  const r = await run(["show"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /project\s+\.claude\/settings\.json\s+unreadable: cannot be read \(\w+\)/);
  assert.match(r.out, /user\s+~\/\.claude\/settings\.json\s+empty/);
  const none = await run(["show"], world("show-none"));
  assert.match(none.out, /\(0 values from 0 files/);
  assert.match(none.out, /\n {2}nothing is set\n/);
});

test("show: a list of more than 40 items is cut, and a long value is clipped", async () => {
  const w = world("show-long", { user: { permissions: { allow: Array.from({ length: 45 }, (_, i) => `Bash(command-${i})`) }, model: `m${"x".repeat(80)}` } });
  const r = await run(["show"], w);
  assert.match(r.out, /permissions\.allow\s+45 items/);
  assert.match(r.out, /\n {6}\.\.\. and 5 more\n/);
  assert.ok(!r.out.includes("command-44"));
  assert.match(r.out, /model\s+"mx+\.\.\.\s+user/);
});

test("show --json: the files, the entries with their sources, the merged tree, and no loaded text", async () => {
  const w = world("show-json", { user: { model: "u", env: { A: "1" } }, project: { model: "p" } });
  const j = (await run(["show", "--json"], w)).json();
  assert.deepEqual(j.files.map((f) => f.scope), ["managed", "local", "project", "user"]);
  assert.deepEqual(j.files.map((f) => f.state), ["not found", "not found", "read", "read"]);
  assert.deepEqual(j.tree, { model: "p", env: { A: "1" } });
  const model = j.entries.find((e) => e.path === "model");
  assert.equal(model.source.scope, "project");
  assert.equal(model.shadowed[0].source.scope, "user");
  assert.equal(model.shadowed[0].value, "u");
  assert.equal(j.counts.shadowed, 1);
  assert.equal(j.settings, undefined);
  assert.ok(Array.isArray(j.notRead) && j.notRead.length === 4);
  assert.equal(strip({ a: 1, settings: { big: true } }).settings, undefined);
});

// ---- lint --------------------------------------------------------------------------------------------------------

test("lint: each file with its findings, the line, the key and what to do; a count at the end", async () => {
  const w = world("lint-text", { user: { model: 5, includeCoAuthoredBy: true } });
  w.write(w.localFile, '{\n  // note\n  "env": {"A": "1",}\n}\n');
  const r = await run(["lint"], w);
  assert.equal(r.code, 1);
  assert.match(r.out, /^claude-settings-doctor \d+\.\d+\.\d+ {2}lint\nproject {3}/);
  assert.match(r.out, /\n\.claude\/settings\.local\.json {2}local settings\n {2}error\s+invalid-json\s+line 2\n {6}The file has a comment \(\/\/\)/);
  assert.match(r.out, /\n {6}fix: Keep the notes in a settings\.jsonc and write settings\.json with claude-settings-doctor build, or delete the comments\.\n/);
  assert.match(r.out, /\n~\/\.claude\/settings\.json {2}user settings\n {2}error\s+wrong-type\s+line 2 {2}model\n/);
  assert.match(r.out, /\n {2}warning\s+deprecated\s+line 3 {2}includeCoAuthoredBy\n/);
  assert.match(r.out, /\n3 errors, 1 warning, 0 notes in 2 files\n$/);
});

test("lint: no file, a file with nothing to say, and --file on one file", async () => {
  const none = await run(["lint"], world("lint-none"));
  assert.equal(none.code, 0);
  assert.match(none.out, /No settings file was found, so there is nothing to check\./);
  assert.match(none.out, /\n0 errors, 0 warnings, 0 notes in 0 files\n$/);
  const clean = await run(["lint"], world("lint-clean", { user: { model: "m" } }));
  assert.match(clean.out, /~\/\.claude\/settings\.json {2}user settings\n {2}no findings\n/);
  const w = world("lint-file");
  const file = `${w.base}/odd.jsonc`;
  fs.writeFileSync(file, '{\n  // fine in a .jsonc\n  "model": 5,\n}\n');
  const one = await run(["lint", "--file", file], w);
  assert.equal(one.code, 1);
  assert.match(one.out, new RegExp(`\nfile {6}${file.replace(/[\\/.]/g, ".")}\n`));
  assert.match(one.out, /wrong-type {8}line 3 {2}model/);
  const missing = await run(["lint", "--file", `${w.base}/nothing.json`], w);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /nothing\.json cannot be read \(ENOENT\)/);
});

test("lint --json: the findings with file, line, column, key path and message", async () => {
  const w = world("lint-json", { user: '{\n  "model": 5,\n  "zzz": 1\n}\n' });
  const j = (await run(["lint", "--json"], w)).json();
  assert.deepEqual(j.counts, { error: 1, warning: 1, note: 0 });
  const f = j.findings[0];
  assert.deepEqual([f.id, f.severity, f.effect, f.scope, f.line, f.column, f.path, f.keyPath], ["wrong-type", "error", "file", "user", 2, 12, "model", ["model"]]);
  assert.equal(f.file, w.userFile);
  assert.match(f.message, /^model should be a string, found a number\./);
  assert.equal(j.schema.downloaded.length, 10);
  assert.ok(j.files.every((x) => !("effective" in x)), "what Claude Code would use is not in the JSON");
});

// ---- the markdown report for the skill ---------------------------------------------------------------------------------

function manyFindings(n) {
  const w = world(`md-${n}`);
  w.user(Object.fromEntries(Array.from({ length: n }, (_, i) => [`unknownSettingNumber${i}`, i])));
  return w;
}

test("markdown: a heading, a count line, one line for each warning and error, and no notes", async () => {
  const w = world("md", { user: { model: 5, includeCoAuthoredBy: true } });
  const r = await run(["lint", "--markdown"], w);
  const lines = r.out.trimEnd().split("\n");
  assert.match(lines[0], /^## settings-doctor lint: /);
  assert.equal(lines[1], "1 settings file read, 1 error, 1 warning, 0 notes. Schema: SchemaStore, downloaded " + lines[1].match(/downloaded (\S+)\./)[1] + ".");
  assert.match(lines[2], /^- ERROR `wrong-type` ~\/\.claude\/settings\.json:2 `model`: model should be a string, found a number\. Claude Code ignores the whole file for this: none of its settings apply\.$/);
  assert.match(lines[3], /^- WARNING `deprecated` ~\/\.claude\/settings\.json:3 `includeCoAuthoredBy`: /);
  assert.equal(lines.length, 4);
  assert.ok(!r.out.includes("claude doctor"), "what Claude Code's own doctor says is for a person, not the model");
});

test("markdown: nothing wrong is said in one line", async () => {
  const r = await run(["lint", "--markdown"], world("md-clean", { user: { model: "m" } }));
  assert.match(r.out, /\nNo findings\.\n$/);
  const empty = await run(["lint", "--markdown"], world("md-empty"));
  assert.match(empty.out, /0 settings files read, 0 errors, 0 warnings, 0 notes/);
  assert.match(empty.out, /No findings\./);
});

test("markdown: at most 12 findings, then how many are left; a line is at most 300 characters", async () => {
  const w = manyFindings(30);
  const r = await run(["lint", "--markdown"], w);
  const lines = r.out.trimEnd().split("\n");
  assert.equal(lines.filter((l) => l.startsWith("- WARNING")).length, 12);
  assert.equal(lines.at(-1), "- ... and 18 more (run `claude-settings-doctor lint`)");
  assert.ok(lines.every((l) => l.length <= 300), `${Math.max(...lines.map((l) => l.length))} characters in the longest line`);
  assert.match(lines[1], /^1 settings file read, 0 errors, 30 warnings/);
});

test("markdown: the worst report is about 18 lines and about a thousand tokens by characters / 4", async () => {
  // as many long findings as a file can give: unknown keys with long names, and a comment and a trailing comma, in all four files
  const w = world("md-worst");
  const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${"averyveryverylongsettingname".repeat(6)}${i}`, i]));
  w.user(keys(40));
  w.project(`{\n  // note\n  "a": 1,\n}\n`);
  w.local(keys(40));
  w.managedSettings(keys(40));
  const r = await run(["lint", "--markdown"], w);
  const lines = r.out.trimEnd().split("\n");
  assert.ok(lines.length <= 18, `${lines.length} lines`);
  assert.ok(r.out.length <= 4800, `${r.out.length} characters`);
  assert.ok(r.out.length / 4 <= 1200);
});

test("markdown: a file that cannot be read says so, and no more", async () => {
  const w = world("md-file");
  const r = await run(["lint", "--markdown", "--file", `${w.base}/nothing.json`], w);
  assert.match(r.out, /\n- ERROR .*nothing\.json cannot be read \(ENOENT\)\n$/);
  const m = buildLint({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, file: `${w.base}/nothing.json` });
  assert.equal(markdownLint(m).trimEnd().split("\n").length, 3);
});

test("markdown: the findings come errors first", async () => {
  const w = world("md-order", { user: { zzz: 1, includeCoAuthoredBy: true, model: 5 } });
  const lines = (await run(["lint", "--markdown"], w)).out.trimEnd().split("\n").slice(2);
  assert.deepEqual(lines.map((l) => l.split(" ")[1]), ["ERROR", "WARNING", "WARNING"]);
});

// ---- the lines of the writing commands --------------------------------------------------------------------------------

test("renderWrite: the lines, a refusal in red, the notes dim, and a dry run marked on every line", () => {
  const plain = renderWrite({ lines: ["Wrote x."], notes: ["Run y."], dryRun: false, refused: null }, { color: false });
  assert.equal(plain, "Wrote x.\nRun y.\n");
  const refused = renderWrite({ lines: ["It changed:"], notes: [], dryRun: false, refused: "no" }, { color: true });
  assert.equal(refused, "It changed:\n\x1b[31mRefused: no\x1b[0m\n");
  const dry = renderWrite({ lines: ["Would write x.", "  + a = 1"], notes: ["Then run y."], dryRun: true, refused: null }, { color: false });
  assert.equal(dry, "(dry run) Would write x.\n(dry run)   + a = 1\nThen run y.\nNothing was written (--dry-run).\n");
  assert.equal(renderWrite({}, { color: false }), "\n", "an empty result is one empty line");
});
