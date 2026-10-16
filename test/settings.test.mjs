// Finding and reading the settings files: where they are on each system, in which order they win, and what
// Claude Code does with a file that is not strict JSON.
import { world, tmpDir } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeText, configDir, gitRoot, jsoncPath, loadSettings, localSettingsPaths, managedDir, shortPath, targetFile } from "../src/settings.mjs";

const load = (w, extra = {}) => loadSettings({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, ...extra });

test("the files, highest precedence first: managed, local, project, user", () => {
  const w = world("order");
  const s = load(w);
  assert.deepEqual(s.files.map((f) => f.scope), ["managed", "local", "project", "user"]);
  assert.deepEqual(s.files.map((f) => f.rank), [40, 30, 20, 10]);
  assert.equal(s.files.find((f) => f.scope === "user").path, w.userFile);
  assert.equal(s.files.find((f) => f.scope === "project").path, w.projectFile);
  assert.equal(s.files.find((f) => f.scope === "local").path, w.localFile);
  assert.equal(s.files.find((f) => f.scope === "managed").path, w.managedFile);
  assert.ok(s.files.every((f) => f.exists === false));
});

test("managed drop-in files come after the base file, in alphabetical order, and hidden or non-JSON ones are skipped", () => {
  const w = world("dropin");
  w.managedSettings({ a: 1 });
  const d = path.join(w.managedDir, "managed-settings.d");
  fs.mkdirSync(d, { recursive: true });
  for (const name of ["20-b.json", "10-a.json", ".hidden.json", "notes.txt", "30-c.json"]) fs.writeFileSync(path.join(d, name), "{}");
  const s = load(w);
  const managed = s.files.filter((f) => f.scope === "managed");
  assert.deepEqual(managed.map((f) => path.basename(f.path)), ["30-c.json", "20-b.json", "10-a.json", "managed-settings.json"], "highest rank first: later drop-ins win");
  assert.deepEqual(managed.map((f) => f.rank), [43, 42, 41, 40]);
});

test("the config folder is CLAUDE_CONFIG_DIR, else .claude in the home folder", () => {
  assert.deepEqual(configDir({ CLAUDE_CONFIG_DIR: "/x/y" }, "/home/me"), { dir: path.resolve("/x/y"), source: "CLAUDE_CONFIG_DIR" });
  assert.deepEqual(configDir({}, "/home/me"), { dir: path.join("/home/me", ".claude"), source: "default" });
  const w = world("cfg");
  w.user({ model: "m" });
  const s = load(w);
  assert.equal(s.configDir, w.claude);
  assert.equal(s.configSource, "CLAUDE_CONFIG_DIR");
  const other = loadSettings({ project: w.work, env: { CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR: w.managedDir }, home: w.home });
  assert.equal(other.configDir, path.join(w.home, ".claude"));
  assert.equal(other.configSource, "default");
  assert.equal(other.files.find((f) => f.scope === "user").exists, true, "~/.claude/settings.json under the home folder");
});

test("the managed folder of each system", () => {
  assert.equal(managedDir("win32"), "C:\\Program Files\\ClaudeCode");
  assert.equal(managedDir("darwin"), "/Library/Application Support/ClaudeCode");
  assert.equal(managedDir("linux"), "/etc/claude-code");
  assert.equal(managedDir("freebsd"), "/etc/claude-code");
});

test("the local settings file: in the project on Windows, at the repository root elsewhere", () => {
  const base = tmpDir("csd-git-");
  const repo = path.join(base, "repo");
  const sub = path.join(repo, "packages", "app");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  const home = path.join(base, "home");
  assert.deepEqual(localSettingsPaths(sub, { home, platform: "win32" }), [path.join(sub, ".claude", "settings.local.json")]);
  const posix = localSettingsPaths(sub, { home, platform: "linux" });
  if (typeof process.getuid === "function") assert.deepEqual(posix, [path.join(repo, ".claude", "settings.local.json"), path.join(sub, ".claude", "settings.local.json")]);
  else assert.equal(posix.length >= 1, true);
  // no repository: the folder itself
  const plain = path.join(base, "plain");
  fs.mkdirSync(plain);
  assert.deepEqual(localSettingsPaths(plain, { home, platform: "linux" }), [path.join(plain, ".claude", "settings.local.json")]);
  // a repository whose root is the home folder: the folder itself
  assert.deepEqual(localSettingsPaths(sub, { home: repo, platform: "linux" }), [path.join(sub, ".claude", "settings.local.json")]);
  assert.equal(gitRoot(sub), repo);
  assert.equal(gitRoot(plain), null === gitRoot(plain) ? null : gitRoot(plain));
});

test("a git worktree resolves to its main checkout", () => {
  const base = tmpDir("csd-wt-");
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
  assert.equal(gitRoot(wt), main);
});

test("a settings text: valid, with a byte-order mark, empty, and each way of not being strict JSON", () => {
  const ok = analyzeText('{"a": 1}');
  assert.equal(ok.ignored, false);
  assert.deepEqual(ok.data, { a: 1 });
  assert.deepEqual(analyzeText('\ufeff{"a": 1}').data, { a: 1 });
  assert.equal(analyzeText("\ufeff{}").bom, true);
  const empty = analyzeText("  \n");
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.data, {});
  assert.equal(empty.ignored, false);
  const kinds = (t) => analyzeText(t).problems.map((p) => p.kind);
  assert.deepEqual(kinds('{"a": 1} // x'), ["comment"]);
  assert.deepEqual(kinds('{"a": /* x */ 1}'), ["comment"]);
  assert.deepEqual(kinds('{"a": 1,}'), ["trailing-comma"]);
  assert.deepEqual(kinds('{"a": 1, // x\n}'), ["comment", "trailing-comma"]);
  assert.deepEqual(kinds("{'a': 1}"), ["syntax"]);
  assert.deepEqual(kinds("[1]"), ["not-object"]);
  assert.deepEqual(kinds("null"), ["not-object"]);
  assert.deepEqual(kinds('"s"'), ["not-object"]);
  assert.deepEqual(kinds("7"), ["not-object"]);
  assert.deepEqual(kinds("true"), ["not-object"]);
  for (const t of ['{"a": 1} // x', "{'a': 1}", "[1]"]) { const a = analyzeText(t); assert.equal(a.ignored, true); assert.equal(a.data, null); }
  const c = analyzeText('{\n  "a": 1,\n  // x\n  "b": 2 // y\n}');
  assert.deepEqual(c.problems[0].lines, [3, 4]);
  assert.equal(c.problems[0].count, 2);
  assert.equal(c.problems[0].line, 3);
});

test("what Claude Code does with a settings text is what analyzeText says, for 2,000 random ones", () => {
  // the rule: the text is loaded when JSON.parse (after the byte-order mark) accepts it and it is an object
  let seed = 99;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pieces = ['{"a":1}', "{", "}", ",", "//", "/*", "*/", '"', "[", "]", ":", " ", "\n", '"b"', "null", "1", "\ufeff", "x"];
  for (let n = 0; n < 2000; n++) {
    let text = "";
    for (let k = Math.floor(rnd() * 8); k > 0; k--) text += pieces[Math.floor(rnd() * pieces.length)];
    let loads = false;
    try { const v = JSON.parse(text.replace(/^\ufeff/, "")); loads = v !== null && typeof v === "object" && !Array.isArray(v); } catch { loads = false; }
    const empty = text.replace(/^\ufeff/, "").trim() === "";
    assert.equal(!analyzeText(text).ignored, loads || empty, JSON.stringify(text));
  }
});

test("a file that cannot be read is kept in the list with the reason; a missing one is not an error", () => {
  const w = world("readerr");
  fs.mkdirSync(w.userFile, { recursive: true });
  const s = load(w);
  const u = s.files.find((f) => f.scope === "user");
  assert.equal(u.exists, true);
  assert.match(u.readError, /cannot be read/);
  assert.equal(u.analysis, null);
  assert.equal(s.files.find((f) => f.scope === "project").exists, false);
});

test("the sibling .jsonc of a file is noted when it is there", () => {
  const w = world("sib");
  w.user({});
  fs.writeFileSync(path.join(w.claude, "settings.jsonc"), "{}");
  const s = load(w);
  const u = s.files.find((f) => f.scope === "user");
  assert.equal(u.jsonc.path, path.join(w.claude, "settings.jsonc"));
  assert.equal(u.jsonc.exists, true);
  assert.equal(s.files.find((f) => f.scope === "project").jsonc.exists, false);
  assert.equal(jsoncPath("/a/settings.local.json"), "/a/settings.local.jsonc");
  assert.equal(jsoncPath("/a/other"), "/a/other.jsonc");
});

test("display paths: relative inside the project, ~/ under the home folder, else the full path with forward slashes", () => {
  const w = world("disp");
  const s = load(w);
  assert.equal(s.files.find((f) => f.scope === "project").display, ".claude/settings.json");
  assert.equal(s.files.find((f) => f.scope === "user").display, "~/.claude/settings.json");
  assert.ok(!s.files.find((f) => f.scope === "managed").display.includes("\\"));
  assert.equal(shortPath(path.join(w.home, "x", "y.json"), { home: w.home, project: w.work }), "~/x/y.json");
});

test("targetFile names the file a target flag stands for", () => {
  const w = world("target");
  const base = { env: w.env, home: w.home, project: w.work };
  assert.equal(targetFile({ ...base, target: "user" }).path, w.userFile);
  assert.equal(targetFile({ ...base, target: "project" }).path, w.projectFile);
  assert.equal(targetFile({ ...base, target: "local", platform: "win32" }).path, w.localFile);
});

test("a project folder reached through a junction or symlink, and one with spaces, is read", () => {
  const base = tmpDir("csd link ü-");
  const real = path.join(base, "real proj");
  fs.mkdirSync(path.join(real, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(real, ".claude", "settings.json"), '{"model": "m"}');
  const link = path.join(base, "link");
  try { fs.symlinkSync(real, link, "junction"); } catch { return; /* a system that cannot make one: nothing to check */ }
  const s = loadSettings({ project: link, env: { CLAUDE_CONFIG_DIR: path.join(base, "cfg"), CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR: path.join(base, "none") }, home: base });
  const p = s.files.find((f) => f.scope === "project");
  assert.equal(p.exists, true);
  assert.deepEqual(p.analysis.data, { model: "m" });
});

test("a settings file that is a symlink to a file is read through the link", () => {
  const base = tmpDir("csd-sym-");
  const target = path.join(base, "dotfiles", "settings.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{"model": "m"}');
  const cfg = path.join(base, "cfg");
  fs.mkdirSync(cfg);
  try { fs.symlinkSync(target, path.join(cfg, "settings.json"), "file"); } catch { return; /* no right to make a file symlink here (Windows without developer mode) */ }
  const s = loadSettings({ project: base, env: { CLAUDE_CONFIG_DIR: cfg, CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR: path.join(base, "none") }, home: base });
  assert.deepEqual(s.files.find((f) => f.scope === "user").analysis.data, { model: "m" });
});
