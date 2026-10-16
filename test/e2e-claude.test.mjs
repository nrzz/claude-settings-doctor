// Checks against the real Claude Code binary, run only when E2E_CLAUDE points at one (see claude-sandbox.mjs).
// They are the proof of what the README says Claude Code does with settings files:
//   a. a comment or a trailing comma in settings.json makes Claude Code ignore the whole file, and a settings.jsonc
//      built into settings.json is read;
//   b. the order of the files (user, project, local) and how they combine: a value is replaced, objects merge key
//      by key, the hooks of every file run, and `show` says what the binary did;
//   c. the lint table (test/lint-table.mjs): `claude doctor` lists what the table says for each of the 91 settings,
//      and the whole file is ignored exactly when the lint says it is; which hooks run when an entry, a group or an
//      event is wrong is what the lint says remains; env values become the strings the lint says;
//   d. the plugin: it validates, /settings-doctor:check hands the model the lint report, its skill adds nothing to
//      a request that does not use it, and its allowed-tools let the model run the command without asking.
// Everything runs against a fake API on 127.0.0.1: no model is reached, no token is spent, nothing leaves the machine,
// and every run has its own throwaway HOME, USERPROFILE and CLAUDE_CONFIG_DIR.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, run } from "./helpers.mjs";
import { CLAUDE, claudeInfo, fakeApi, put, readLog, recorder, runClaude, sandbox, sessionStartHook, skip, textBlocks, userText } from "./claude-sandbox.mjs";
import { ROWS } from "./lint-table.mjs";
import { loadSettings } from "../src/settings.mjs";
import { lintSettings } from "../src/lint.mjs";
import { buildFromJsonc } from "../src/build.mjs";

const IS_WIN = process.platform === "win32";
const fwd = (p) => p.replace(/\\/g, "/");

// What the tool says, for the files of a sandbox
const toolWorld = (sb, project = sb.work) => ({ project, env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, USERPROFILE: sb.home, CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR: path.join(sb.root, "managed") }, home: sb.home, managed: path.join(sb.root, "managed") });
const toolRun = (sb, args, project = sb.work) => run(args, { work: project, env: toolWorld(sb, project).env, home: sb.home, managedDir: path.join(sb.root, "managed") });
const lintOf = (sb) => lintSettings(loadSettings(toolWorld(sb)));

// The main request of a run: the one that carries the prompt
const main = (api) => api.requests.find((r) => userText(r).includes("PROBE-MAIN")) || api.requests[0];
// The request that carries a skill's text (a version may send other requests too, for a title or a quota check)
const withSkill = (api) => api.requests.find((r) => textBlocks(r).some((b) => b.startsWith("Base directory for this skill")));

/** Run `claude -p` in a sandbox whose settings files are `files` and say what it did: the model it asked for, the hooks that ran. */
async function probe(label, files, { args = [], env = {}, prompt = "PROBE-MAIN hello" } = {}) {
  const sb = sandbox(label);
  for (const [name, value] of Object.entries(files)) put(sb[name], value);
  const api = await fakeApi();
  try {
    const r = await runClaude(sb, api, ["-p", prompt, "--output-format", "json", ...args], { env });
    const req = main(api);
    const log = readLog(sb);
    return { sb, api, r, request: req, model: req ? req.model : null, ran: log.map((l) => l.label).sort(), log };
  } finally { await api.close(); }
}

// Run `items` through `fn`, `width` at a time
async function pool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

const hooks = (label) => sessionStartHook(label);
const textOf = (v) => JSON.stringify(v, null, 2);

// -------------------------------------------------------------------------------------------------------------------

test("the binary: its version is recorded for the README", { skip: skip() }, (t) => {
  t.diagnostic(`Claude Code ${claudeInfo().version} on ${process.platform}, Node ${process.version}`);
  assert.match(claudeInfo().version, /^\d+\.\d+\.\d+/);
});

// ---- (d) the plugin validates ---------------------------------------------------------------------------------------

test("claude plugin validate accepts the plugin, also with --strict", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("validate");
  for (const args of [["plugin", "validate", ROOT], ["plugin", "validate", ROOT, "--strict"], ["plugin", "validate", path.join(ROOT, ".claude-plugin", "plugin.json"), "--strict"]]) {
    const r = await runClaude(sb, null, args);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Validation passed/);
  }
});

// ---- (a) a comment or a trailing comma ---------------------------------------------------------------------------------

const withHook = (extra) => `{\n${extra}  "model": "m-probe",\n  "hooks": ${JSON.stringify(hooks("ran"))}\n}\n`;
const VARIANTS = [
  ["a // comment on its own line", withHook("  // a note\n"), true],
  ["a // comment after a value", withHook("").replace('"m-probe",', '"m-probe", // pick'), true],
  ["a /* */ comment", withHook("  /* a note */\n"), true],
  ["a comment on the first line", `// settings\n${withHook("")}`, true],
  ["a trailing comma in an object", withHook("").replace(/\n\}\n$/, ",\n}\n"), true],
  ["a trailing comma in an array", `{\n  "model": "m-probe",\n  "permissions": {"allow": ["Bash(ls)",]},\n  "hooks": ${JSON.stringify(hooks("ran"))}\n}\n`, true],
  ["strict JSON, the same settings", withHook(""), false],
  ["strict JSON with CRLF line endings", withHook("").replace(/\n/g, "\r\n"), false],
  ["strict JSON with a byte-order mark", `\ufeff${withHook("")}`, false],
];

test("a comment or a trailing comma makes Claude Code ignore the whole settings.json (user, project and local); strict JSON is read", { skip: skip(), timeout: 300000 }, async (t) => {
  const jobs = [];
  for (const [what, text, ignored] of VARIANTS) for (const scope of ["user", "project", "local"]) jobs.push({ what, text, ignored, scope });
  const results = await pool(jobs, 4, async (j) => {
    const p = await probe("cmt", { [j.scope]: j.text });
    return { ...j, model: p.model, ran: p.ran, said: `${p.r.err}\n${p.r.result ? p.r.result.result : ""}`, lint: lintOf(p.sb).files.find((f) => f.scope === j.scope) };
  });
  for (const r of results) {
    const applied = r.model === "m-probe";
    assert.equal(applied, !r.ignored, `${r.scope}: ${r.what}: the model was ${r.model}`);
    assert.doesNotMatch(r.said, /invalid|malformed/i, `${r.scope}: ${r.what}: a -p run says nothing about the file it ignored`);
    assert.deepEqual(r.ran, r.ignored ? [] : ["ran"], `${r.scope}: ${r.what}: the hook ${r.ignored ? "ran" : "did not run"}`);
    // the lint agrees with the binary
    assert.equal(r.lint.effective.ignored !== null, r.ignored, `${r.scope}: ${r.what}: the lint says ${JSON.stringify(r.lint.effective.ignored)}`);
    if (r.ignored) assert.ok(r.lint.findings.some((f) => f.id === "invalid-json" && f.effect === "file"), `${r.scope}: ${r.what}`);
    else assert.deepEqual(r.lint.findings.filter((f) => f.severity !== "note"), [], `${r.scope}: ${r.what}`);
  }
  t.diagnostic(`${results.length} files (${VARIANTS.length} kinds in 3 places): the whole file was ignored for each of the ${results.filter((r) => r.ignored).length} with a comment or a trailing comma, and read for each of the ${results.filter((r) => !r.ignored).length} without`);
});

test("a settings.jsonc with comments, built into settings.json, is read by Claude Code", { skip: skip(), timeout: 120000 }, async () => {
  const sb = sandbox("built");
  const source = `// my settings\n{\n  // the model for tests\n  "model": "m-probe", // pick\n  "env": { "CSD_FROM": "jsonc", },\n  "hooks": ${JSON.stringify(hooks("ran"))},\n}\n`;
  fs.mkdirSync(sb.cfg, { recursive: true });
  fs.writeFileSync(`${sb.user}c`, source);
  // before the build there is no settings.json, so nothing is read
  const before = await toolRun(sb, ["check", "--user"]);
  assert.equal(before.code, 1);
  const built = await toolRun(sb, ["build", "--user"]);
  assert.equal(built.code, 0, built.all);
  assert.ok(!fs.readFileSync(sb.user, "utf8").includes("//"));
  const api = await fakeApi();
  try {
    await runClaude(sb, api, ["-p", "PROBE-MAIN hi", "--output-format", "json"]);
    assert.equal(main(api).model, "m-probe");
    const log = readLog(sb);
    assert.deepEqual(log.map((l) => l.label), ["ran"]);
    assert.equal(log[0].env.CSD_FROM, "jsonc", "the env key reached the hook");
  } finally { await api.close(); }
  // the commented file next to it is never read by Claude Code: a model only in settings.jsonc would not apply
  const sb2 = sandbox("jsonc-only");
  fs.writeFileSync(`${sb2.user}c`, '{ "model": "m-probe" }');
  const api2 = await fakeApi();
  try {
    await runClaude(sb2, api2, ["-p", "PROBE-MAIN hi", "--output-format", "json"]);
    assert.notEqual(main(api2).model, "m-probe", "settings.jsonc alone does nothing");
  } finally { await api2.close(); }
});

test("absorb: an edit made to settings.json while Claude Code runs (the file as Claude Code writes it) goes back into settings.jsonc and the binary still reads the result", { skip: skip(), timeout: 120000 }, async () => {
  const sb = sandbox("absorb");
  fs.writeFileSync(`${sb.user}c`, `{\n  // keep\n  "model": "m-probe",\n  "hooks": ${JSON.stringify(hooks("ran"))}\n}\n`);
  assert.equal((await toolRun(sb, ["build", "--user"])).code, 0);
  const data = JSON.parse(fs.readFileSync(sb.user, "utf8"));
  data.env = { CSD_ADDED: "by-claude" };
  fs.writeFileSync(sb.user, `${JSON.stringify(data, null, 2)}\n`);
  assert.equal((await toolRun(sb, ["absorb", "--user"])).code, 0);
  assert.match(fs.readFileSync(`${sb.user}c`, "utf8"), /\/\/ keep/);
  assert.equal((await toolRun(sb, ["build", "--user"])).code, 0);
  const api = await fakeApi();
  try {
    await runClaude(sb, api, ["-p", "PROBE-MAIN hi", "--output-format", "json"]);
    assert.equal(main(api).model, "m-probe");
    assert.equal(readLog(sb)[0].env.CSD_ADDED, "by-claude");
  } finally { await api.close(); }
});

// ---- (b) precedence and how the files combine ----------------------------------------------------------------------------

test("the user file, the project file and the local file: the higher one wins a value, every key of every env arrives, the hooks of every file run; and `show` says the same", { skip: skip(), timeout: 300000 }, async (t) => {
  const user = { model: "m-user", env: { CSD_A: "user", CSD_U: "u" }, hooks: hooks("user") };
  const project = { model: "m-project", env: { CSD_A: "project", CSD_P: "p" }, hooks: hooks("project") };
  const local = { model: "m-local", env: { CSD_A: "local", CSD_L: "l" }, hooks: hooks("local") };
  const cases = [
    ["user alone", { user }, "m-user", { CSD_A: "user", CSD_U: "u" }, ["user"]],
    ["project over user", { user, project }, "m-project", { CSD_A: "project", CSD_U: "u", CSD_P: "p" }, ["project", "user"]],
    ["local over project", { project, local }, "m-local", { CSD_A: "local", CSD_P: "p", CSD_L: "l" }, ["local", "project"]],
    ["local over user", { user, local }, "m-local", { CSD_A: "local", CSD_U: "u", CSD_L: "l" }, ["local", "user"]],
    ["all three", { user, project, local }, "m-local", { CSD_A: "local", CSD_U: "u", CSD_P: "p", CSD_L: "l" }, ["local", "project", "user"]],
  ];
  const results = await pool(cases, 3, async ([name, files, model, env, ran]) => {
    const p = await probe("prec", files);
    const shown = (await toolRun(p.sb, ["show", "--json"])).json();
    return { name, p, model, env, ran, shown };
  });
  for (const { name, p, model, env, ran, shown } of results) {
    assert.equal(p.model, model, `${name}: the model the binary asked for`);
    assert.deepEqual(p.ran, ran, `${name}: the hooks that ran`);
    const seen = Object.fromEntries(Object.entries(p.log[0].env).filter(([k]) => /^CSD_[A-Z]$/.test(k)));
    assert.deepEqual(seen, env, `${name}: the env the hooks saw`);
    // `show` says what the binary did
    assert.equal(shown.tree.model, p.model, `${name}: show's model`);
    assert.deepEqual(shown.tree.env, env, `${name}: show's env`);
    const items = shown.entries.find((e) => e.path === "hooks.SessionStart").items;
    assert.deepEqual(items.map((i) => i.value.hooks[0].args[1]).sort(), p.ran, `${name}: show's hooks`);
    assert.equal(shown.entries.find((e) => e.path === "model").source.scope, model.slice(2), `${name}: show names the file of the model`);
  }
  t.diagnostic(`${cases.length} combinations: show agreed with the binary on the model, the env and the hooks in each`);
});

test("lists are joined across files: the hooks of an event in two files all run", { skip: skip(), timeout: 180000 }, async () => {
  const p = await probe("join", { user: { hooks: { SessionStart: [{ hooks: [recorder("u1")] }, { hooks: [recorder("u2")] }] } }, project: { hooks: { SessionStart: [{ hooks: [recorder("p1"), recorder("p2")] }] } } });
  assert.deepEqual(p.ran, ["p1", "p2", "u1", "u2"]);
  const shown = (await toolRun(p.sb, ["show", "--json"])).json();
  assert.equal(shown.entries.find((e) => e.path === "hooks.SessionStart").items.length, 3, "three groups, from two files");
});

test("in a git repository the binary reads the project file of the folder it starts in; `show` agrees about the project file and the local file", { skip: skip(), timeout: 180000 }, async (t) => {
  const sb = sandbox("gitroot");
  const root = path.join(sb.root, "repo");
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub, { recursive: true });
  const git = spawnSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  assert.equal(git.status, 0, "git is there");
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [] };
  fs.writeFileSync(path.join(sb.cfg, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [root]: trusted, [sub]: trusted, [fwd(root)]: trusted, [fwd(sub)]: trusted } }));
  put(path.join(root, ".claude", "settings.json"), { hooks: hooks("root-project") });
  put(path.join(sub, ".claude", "settings.json"), { hooks: hooks("sub-project") });
  put(path.join(root, ".claude", "settings.local.json"), { hooks: hooks("root-local") });
  put(path.join(sub, ".claude", "settings.local.json"), { hooks: hooks("sub-local") });
  const api = await fakeApi();
  try {
    await runClaude(sb, api, ["-p", "PROBE-MAIN hi", "--output-format", "json"], { cwd: sub });
  } finally { await api.close(); }
  const ran = readLog(sb).map((l) => l.label).sort();
  const shown = (await toolRun(sb, ["show", "--json", "--project", sub], sub)).json();
  const predicted = shown.entries.find((e) => e.path === "hooks.SessionStart").items.map((i) => i.value.hooks[0].args[1]).sort();
  t.diagnostic(`on ${process.platform}, started in repo/sub: the binary ran ${ran.join(", ")}; show predicted ${predicted.join(", ")}`);
  assert.ok(ran.includes("sub-project") && !ran.includes("root-project"), "the project file is the one in the folder Claude Code starts in");
  assert.deepEqual(predicted, ran, "show names the files the binary used");
});

// ---- (c) unknown keys, wrong types, what remains of a file ------------------------------------------------------------------

test("a key the schema does not know is ignored without a word: the rest of the file applies, `claude doctor` says nothing, the lint warns", { skip: skip(), timeout: 120000 }, async () => {
  const p = await probe("unknown", { user: { model: "m-probe", notARealKey: true, permisions: { allow: [] }, hooks: hooks("ran") } });
  assert.equal(p.model, "m-probe");
  assert.deepEqual(p.ran, ["ran"]);
  const doctor = await runClaude(p.sb, null, ["doctor"]);
  assert.doesNotMatch(doctor.out, /Invalid settings/);
  assert.doesNotMatch(doctor.out, /notARealKey|permisions/);
  const lint = lintOf(p.sb).files.find((f) => f.scope === "user");
  assert.deepEqual(lint.findings.map((f) => `${f.id} ${f.path}`).sort(), ["unknown-key notARealKey", "unknown-key permisions"]);
  assert.equal(lint.effective.ignored, null);
});

test("a key repeated in an object: Claude Code keeps the last, as the lint says", { skip: skip(), timeout: 120000 }, async () => {
  const text = `{"env": {"CSD_A": "first"}, "env": {"CSD_B": "second"}, "model": "m-probe", "hooks": ${JSON.stringify(hooks("ran"))}}`;
  const p = await probe("dup", { user: text });
  assert.equal(p.model, "m-probe");
  const seen = Object.fromEntries(Object.entries(p.log[0].env).filter(([k]) => /^CSD_[AB]$/.test(k)));
  assert.deepEqual(seen, { CSD_B: "second" });
  assert.deepEqual(lintOf(p.sb).files.find((f) => f.scope === "user").findings.map((f) => f.id), ["duplicate-key"]);
});

test("env values that are not strings arrive as the strings the lint says", { skip: skip(), timeout: 120000 }, async () => {
  const env = { CSD_NUM: 1, CSD_FLOAT: 1.5, CSD_BOOL: false, CSD_NULL: null, CSD_ARR: [1, 2], CSD_OBJ: { x: 1 }, CSD_STR: "s" };
  const p = await probe("envtypes", { user: { env, hooks: hooks("ran") } });
  const seen = Object.fromEntries(Object.entries(p.log[0].env).filter(([k]) => k.startsWith("CSD_") && k !== "CSD_LOG"));
  assert.deepEqual(seen, { CSD_NUM: "1", CSD_FLOAT: "1.5", CSD_BOOL: "false", CSD_NULL: "null", CSD_ARR: "1,2", CSD_OBJ: "[object Object]", CSD_STR: "s" });
  const lint = lintOf(p.sb).files.find((f) => f.scope === "user");
  const coerced = Object.fromEntries(lint.effective.coerced.map((c) => [c.path[1], c.to]));
  assert.deepEqual(coerced, { CSD_NUM: "1", CSD_FLOAT: "1.5", CSD_BOOL: "false", CSD_NULL: "null", CSD_ARR: "1,2", CSD_OBJ: "[object Object]" }, "the lint predicted each string");
  const doctor = await runClaude(p.sb, null, ["doctor"]);
  assert.doesNotMatch(doctor.out, /Invalid settings/, "claude doctor does not mind");
});

// `claude doctor` prints "Invalid settings" and then one line for each thing it dropped
function doctorPaths(text, file) {
  const m = /Invalid settings\r?\n([\s\S]*?)\r?\n\r?\n/.exec(text);
  if (!m) return [];
  const got = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.startsWith("- ")) continue;
    const rest = line.slice(2);
    if (!rest.startsWith(file)) { got.push(`?? ${rest}`); continue; }
    const tail = rest.slice(file.length);
    got.push(tail.startsWith(" › ") ? tail.slice(3).split(": ")[0] : "(file)");
  }
  return [...new Set(got)].sort();
}

test("the lint table put to the binary: for each of the settings, `claude doctor` lists what the table says, and the file applies exactly when the lint says it does", { skip: skip(), timeout: 600000 }, async (t) => {
  const results = await pool(ROWS, 4, async (row) => {
    const sb = sandbox("row");
    put(sb.user, row.file);
    const doctor = await runClaude(sb, null, ["doctor"]);
    const got = doctorPaths(doctor.out, sb.user);
    // does the file apply at all? a model in the file arrives in the request when it does
    let applied = null;
    if (row.file !== null && typeof row.file === "object" && !("model" in row.file)) {
      const probeSb = sandbox("rowprobe");
      put(probeSb.user, { ...row.file, model: "m-probe" });
      const api = await fakeApi();
      try {
        await runClaude(probeSb, api, ["-p", "PROBE-MAIN hi", "--output-format", "json"]);
        applied = main(api) ? main(api).model === "m-probe" : null;
      } finally { await api.close(); }
    }
    const lint = lintOf(sb).files.find((f) => f.scope === "user");
    return { row, got, applied, lintIgnored: lint.effective.ignored !== null };
  });
  let effectChecked = 0;
  for (const r of results) {
    assert.deepEqual(r.got, [...r.row.doctor].sort(), `${r.row.name}: what claude doctor lists`);
    if (r.applied !== null) {
      effectChecked++;
      assert.equal(r.applied, !r.lintIgnored, `${r.row.name}: the binary ${r.applied ? "applied" : "ignored"} the file; the lint says it is ${r.lintIgnored ? "ignored" : "applied"}`);
    }
  }
  t.diagnostic(`${results.length} settings put to the binary: claude doctor agreed with the table on all ${results.length}; for ${effectChecked} of them (an object without a model) the file was applied or ignored as the lint says`);
  assert.ok(effectChecked >= 60);
});

// The hooks that run when something in a hook list is wrong, and what the lint says remains
const HOOK_CASES = [
  ["a bad entry beside a good one, and another group", { SessionStart: [{ hooks: [{ ...recorder("bad"), timeout: "10" }, recorder("sibling")] }, { hooks: [recorder("othergroup")] }] }, ["othergroup", "sibling"]],
  ["a matcher that is a number", { SessionStart: [{ matcher: 5, hooks: [recorder("bad-group")] }, { hooks: [recorder("othergroup")] }] }, ["othergroup"]],
  ["a group that is a string", { SessionStart: ["x", { hooks: [recorder("othergroup")] }] }, ["othergroup"]],
  ["a group with no hooks", { SessionStart: [{ matcher: "x" }, { hooks: [recorder("othergroup")] }] }, ["othergroup"]],
  ["an event that does not exist, beside one that does", { SessionStarts: [{ hooks: [recorder("typo")] }], SessionStart: [{ hooks: [recorder("real")] }] }, ["real"]],
  ["an event that is an object, beside one that is fine", { Stop: {}, SessionStart: [{ hooks: [recorder("real")] }] }, ["real"]],
  ["a field the schema does not have in an entry", { SessionStart: [{ hooks: [{ ...recorder("extra-field"), retries: 3 }] }] }, ["extra-field"]],
  ["a field the schema does not have in a group", { SessionStart: [{ foo: 1, hooks: [recorder("group-extra")] }] }, ["group-extra"]],
  ["a type in the wrong case", { SessionStart: [{ hooks: [{ ...recorder("bad"), type: "Command" }, recorder("sibling")] }] }, ["sibling"]],
  ["an async that is a string", { SessionStart: [{ hooks: [{ ...recorder("bad"), async: "yes" }, recorder("sibling")] }] }, ["sibling"]],
  ["an event written in lower case", { sessionstart: [{ hooks: [recorder("lower")] }] }, []],
  ["a bad entry in Stop only costs the entry", { Stop: [{ hooks: [{ type: "command", command: "x", timeout: "10" }] }], SessionStart: [{ hooks: [recorder("session")] }] }, ["session"]],
  ["a bad entry in PreToolUse costs the whole file", { PreToolUse: [{ hooks: [{ type: "command", command: "x", timeout: "10" }] }], SessionStart: [{ hooks: [recorder("session")] }] }, []],
  ["a bad matcher in PermissionRequest costs the whole file", { PermissionRequest: [{ matcher: 5, hooks: [{ type: "command", command: "x" }] }], SessionStart: [{ hooks: [recorder("session")] }] }, []],
];

test("when an entry, a group or an event of hooks is wrong, the hooks that run are the ones the lint says remain", { skip: skip(), timeout: 300000 }, async (t) => {
  const results = await pool(HOOK_CASES, 4, async ([name, h, expected]) => {
    const p = await probe("hookcase", { user: { model: "m-probe", hooks: h } });
    const effective = lintOf(p.sb).files.find((f) => f.scope === "user").effective;
    const remains = [];
    if (effective.data && effective.data.hooks && Array.isArray(effective.data.hooks.SessionStart)) {
      for (const g of effective.data.hooks.SessionStart) for (const e of (g.hooks || [])) if (e && e.args) remains.push(e.args[1]);
    }
    return { name, p, expected, remains: remains.sort(), ignored: effective.ignored !== null };
  });
  for (const r of results) {
    assert.deepEqual(r.p.ran, r.expected, `${r.name}: the hooks that ran`);
    assert.deepEqual(r.remains, r.expected, `${r.name}: the hooks the lint says remain`);
    assert.equal(r.p.model === "m-probe", !r.ignored, `${r.name}: the file ${r.ignored ? "is" : "is not"} ignored whole, the model says ${r.p.model}`);
  }
  t.diagnostic(`${results.length} hook lists with something wrong: the hooks that ran were the ones the lint said remain, in each`);
});

test("a matcher that is not a regular expression never matches: its hooks do not run, and the lint says so; the others do", { skip: skip(), timeout: 120000 }, async () => {
  const p = await probe("regex", { user: { model: "m-probe", hooks: { SessionStart: [{ matcher: "(", hooks: [recorder("bad-regex")] }, { matcher: "*", hooks: [recorder("star")] }, { matcher: "startup", hooks: [recorder("startup")] }, { matcher: "resume", hooks: [recorder("resume")] }] } } });
  assert.deepEqual(p.ran, ["star", "startup"], "a -p run starts a session: the matcher '(' and 'resume' match nothing");
  assert.ok(lintOf(p.sb).files.find((f) => f.scope === "user").findings.some((f) => f.id === "hook-matcher" && f.path === "hooks.SessionStart[0].matcher"), "the lint warns about the matcher");
});

test("an empty file and a file of spaces: nothing is read, claude doctor says nothing, and the lint notes that the file is empty", { skip: skip(), timeout: 120000 }, async () => {
  for (const text of ["", "  \n"]) {
    const p = await probe("empty", { user: text });
    const doctor = await runClaude(p.sb, null, ["doctor"]);
    assert.doesNotMatch(doctor.out, /Invalid settings/);
    assert.deepEqual(lintOf(p.sb).files.find((f) => f.scope === "user").findings.map((f) => f.id), ["empty-file"]);
  }
});

// ---- (d) the skill ------------------------------------------------------------------------------------------------------

const SKILL_FILES = { user: { model: "m-probe", includeCoAuthoredBy: true }, project: '{\n  // a note\n  "cleanupPeriodDay": 3\n}\n' };

test("the user-only skill adds nothing to a request that does not use it: no tool, no skill list entry, no word of it", { skip: skip(), timeout: 180000 }, async (t) => {
  const sb = sandbox("always");
  put(sb.user, SKILL_FILES.user);
  const without = await fakeApi();
  const withPlugin = await fakeApi();
  try {
    await runClaude(sb, without, ["-p", "PROBE-MAIN hello", "--output-format", "json"]);
    await runClaude(sb, withPlugin, ["-p", "PROBE-MAIN hello", "--plugin-dir", ROOT, "--output-format", "json"]);
    // the two runs are the same but for the ids and the times that every request carries
    const plain = (r) => JSON.stringify(r).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g, "<time>");
    const a = plain(main(without));
    const b = plain(main(withPlugin));
    assert.ok(!b.includes("settings-doctor"), "nothing of the plugin is in the request");
    assert.ok(!b.includes("Check settings files"), "not even the skill's description");
    assert.equal(JSON.stringify(main(withPlugin).tools), JSON.stringify(main(without).tools), "the tool list is the same");
    assert.equal(b.length, a.length, "the request has the same size with the plugin loaded");
    t.diagnostic(`plain prompt: ${a.length} characters without the plugin, ${b.length} with it; the string settings-doctor appears ${b.split("settings-doctor").length - 1} times`);
  } finally { await without.close(); await withPlugin.close(); }
});

test("/settings-doctor:check hands the model the lint report for the project, whichever way Claude Code runs the command line, and what it costs is measured", { skip: skip(), timeout: 240000 }, async (t) => {
  const sb = sandbox("skill");
  put(sb.user, SKILL_FILES.user);
  put(sb.project, SKILL_FILES.project);
  const api = await fakeApi();
  try {
    const r = await runClaude(sb, api, ["-p", "/settings-doctor:check", "--plugin-dir", ROOT, "--output-format", "json"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(withSkill(api), "the skill reached the model, although the lint found problems (its command must not fail)");
    const blocks = textBlocks(withSkill(api));
    const skillText = blocks.find((b) => b.startsWith("Base directory for this skill"));
    assert.ok(skillText, `the skill text is in the request:\n${blocks.map((b) => b.slice(0, 80)).join("\n")}`);
    const commandText = blocks.find((b) => b.includes("<command-name>/settings-doctor:check</command-name>"));
    // Claude Code hands the model the ! line in one of two forms: its output pasted in its place, or an instruction to run it
    if (/run this first/.test(skillText)) {
      assert.ok(skillText.includes(`bin/claude-settings-doctor.mjs" lint --project "${fwd(sb.work)}" --markdown`), `the command, with the plugin folder and the project folder filled in:\n${skillText}`);
    } else {
      assert.match(skillText, new RegExp(`## settings-doctor lint: ${sb.work.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
      assert.match(skillText, /- ERROR `invalid-json`/);
      assert.match(skillText, /- WARNING `deprecated`/);
      assert.match(skillText, /- WARNING `unknown-key`/);
    }
    assert.match(skillText, /In at most 10 lines: each problem with its settings file and line, and the fix\./);
    assert.match(skillText, /Edit nothing until the user agrees\./);
    assert.ok(!skillText.includes("${CLAUDE_"), "no variable is left unexpanded");
    const chars = skillText.length + (commandText ? commandText.length : 0);
    t.diagnostic(`/settings-doctor:check on a project with 3 findings: ${skillText.length} characters in the skill block${commandText ? ` and ${commandText.length} in the command block` : ""}, about ${Math.round(chars / 4)} tokens by characters / 4`);
    assert.ok(chars < 2500, `${chars} characters`);
  } finally { await api.close(); }
});

test("/settings-doctor:check on a project with nothing wrong says so in one line", { skip: skip(), timeout: 120000 }, async () => {
  const sb = sandbox("skill-clean");
  put(sb.user, { model: "m-probe" });
  const api = await fakeApi();
  try {
    await runClaude(sb, api, ["-p", "/settings-doctor:check", "--plugin-dir", ROOT, "--output-format", "json"]);
    const skillText = textBlocks(withSkill(api) || main(api)).find((b) => b.startsWith("Base directory for this skill"));
    assert.ok(skillText);
    if (!/run this first/.test(skillText)) assert.match(skillText, /No findings\./);
  } finally { await api.close(); }
});

test("the worst report the skill can hand over is capped, and its size is measured", { skip: skip(), timeout: 180000 }, async (t) => {
  const sb = sandbox("skill-worst");
  const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${"averyveryverylongsettingname".repeat(6)}${i}`, i]));
  put(sb.user, keys(40));
  put(sb.project, keys(40));
  put(sb.local, '{\n  // note\n  "a": 1,\n}\n');
  const api = await fakeApi();
  try {
    await runClaude(sb, api, ["-p", "/settings-doctor:check", "--plugin-dir", ROOT, "--output-format", "json"]);
    const skillText = textBlocks(withSkill(api) || main(api)).find((b) => b.startsWith("Base directory for this skill"));
    assert.ok(skillText);
    if (/run this first/.test(skillText)) return;
    t.diagnostic(`worst case built here: ${skillText.length} characters in the skill block, ${skillText.split("\n").length} lines, about ${Math.round(skillText.length / 4)} tokens by characters / 4`);
    assert.ok(skillText.length < 5600, `${skillText.length} characters`);
    assert.match(skillText, /- \.\.\. and \d+ more \(run `claude-settings-doctor lint`\)/);
  } finally { await api.close(); }
});

test("the skill's allowed-tools let the model run the command with no prompt (permission mode default): the Bash tool, and on Windows the PowerShell tool", { skip: skip(), timeout: 240000 }, async () => {
  for (const [tool, env] of [["Bash", {}], ...(IS_WIN ? [["PowerShell", { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", CLAUDE_CODE_GIT_BASH_PATH: "C:/nonexistent/bash.exe" }]] : [])]) {
    const sb = sandbox(`allowed-${tool}`);
    put(sb.user, { model: "m-probe", includeCoAuthoredBy: true });
    const command = `node "${fwd(ROOT)}/bin/claude-settings-doctor.mjs" lint --project "${fwd(sb.work)}" --markdown`;
    const api = await fakeApi({ tool, input: { command, description: "Run the lint" } });
    try {
      const r = await runClaude(sb, api, ["-p", "/settings-doctor:check PROBE-MAIN", "--plugin-dir", ROOT, "--output-format", "json", "--permission-mode", "default", "--max-turns", "3"], { env });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(r.result.permission_denials, [], `${tool}: nothing was refused`);
      // each later request repeats the conversation so far: one result for the one call
      const seen = new Map();
      for (const b of api.requests.flatMap((rq) => rq.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))) if (b.type === "tool_result") seen.set(b.tool_use_id, b);
      const results = [...seen.values()];
      assert.equal(results.length, 1, `${tool}: the command ran`);
      assert.match(JSON.stringify(results[0].content), /## settings-doctor lint/, `${tool}: and printed the report`);
    } finally { await api.close(); }
  }
});

test("on Windows, with the PowerShell tool and the default permission mode, the skill still hands over the report (the PowerShell patterns in allowed-tools)", { skip: skip() || (!IS_WIN && "the PowerShell tool is a Windows setup here"), timeout: 180000 }, async () => {
  const sb = sandbox("skill-ps");
  put(sb.user, { model: "m-probe", includeCoAuthoredBy: true });
  const api = await fakeApi();
  try {
    const r = await runClaude(sb, api, ["-p", "/settings-doctor:check", "--plugin-dir", ROOT, "--output-format", "json", "--permission-mode", "default"], { env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", CLAUDE_CODE_GIT_BASH_PATH: "C:/nonexistent/bash.exe" } });
    assert.equal(r.code, 0, r.err);
    assert.ok(withSkill(api), "the skill reached the model");
    const skillText = textBlocks(withSkill(api)).find((b) => b.startsWith("Base directory for this skill"));
    assert.ok(skillText.includes("## settings-doctor lint") || /run this first/.test(skillText), skillText);
  } finally { await api.close(); }
});

test("installed from a marketplace, the plugin's own cost projection is small and its skill is one user-only skill", { skip: skip(), timeout: 300000 }, async (t) => {
  const sb = sandbox("details");
  const mkt = path.join(sb.root, "mkt");
  const dest = path.join(mkt, "plugins", "settings-doctor");
  fs.mkdirSync(path.join(mkt, ".claude-plugin"), { recursive: true });
  for (const item of ["bin", "src", "skills", ".claude-plugin", "package.json"]) fs.cpSync(path.join(ROOT, item), path.join(dest, item), { recursive: true });
  fs.writeFileSync(path.join(mkt, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "local-test", owner: { name: "test" }, plugins: [{ name: "settings-doctor", description: "x", source: "./plugins/settings-doctor" }] }));
  const claude = (...args) => runClaude(sb, null, args, { timeout: 100000 });
  const added = await claude("plugin", "marketplace", "add", mkt);
  assert.equal(added.code, 0, added.out + added.err);
  const installed = await claude("plugin", "install", "settings-doctor@local-test");
  assert.equal(installed.code, 0, installed.out + installed.err);
  const details = await claude("plugin", "details", "settings-doctor");
  assert.equal(details.code, 0, details.out + details.err);
  assert.match(details.out, /Skills \(1\)\s+check/);
  assert.match(details.out, /Hooks \(0\)/);
  const always = /Always-on:\s+~(\d+) tok/.exec(details.out);
  assert.ok(always && Number(always[1]) < 30, `always-on is ${always && always[1]} tokens`);
  const row = /^\s*check\s+.*$/m.exec(details.out);
  t.diagnostic(`claude plugin details: ${always[0].replace(/\s+/g, " ")}; per component: ${row ? row[0].trim().replace(/\s+/g, " ") : "(no row)"}`);
});

test("when the shell tool is not allowed for the command, Claude Code hands the model the command line as 'run this first', and the skill text reads right that way too (Windows, PowerShell tool)", { skip: skip() || (!IS_WIN && "this is how the PowerShell tool of a Windows setup behaves here"), timeout: 180000 }, async () => {
  // a copy of the plugin whose skill has no allowed-tools line
  const copy = path.join(sandbox("copy").root, "plugin");
  for (const item of ["bin", "src", "skills", ".claude-plugin", "package.json"]) fs.cpSync(path.join(ROOT, item), path.join(copy, item), { recursive: true });
  const skillFile = path.join(copy, "skills", "check", "SKILL.md");
  const text = fs.readFileSync(skillFile, "utf8");
  assert.match(text, /^allowed-tools: .*\n/m);
  fs.writeFileSync(skillFile, text.replace(/^allowed-tools: .*\n/m, ""));
  const sb = sandbox("runfirst");
  put(sb.user, { model: "m-probe", includeCoAuthoredBy: true });
  const api = await fakeApi();
  try {
    const r = await runClaude(sb, api, ["-p", "/settings-doctor:check", "--plugin-dir", copy, "--output-format", "json"], { env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", CLAUDE_CODE_GIT_BASH_PATH: "C:/nonexistent/bash.exe" } });
    assert.equal(r.code, 0, r.err);
    const skillText = textBlocks(withSkill(api) || main(api)).find((b) => b.startsWith("Base directory for this skill"));
    assert.ok(skillText, "the skill reached the model");
    assert.match(skillText, /\[run this first, exactly as written, with the PowerShell tool and use its output: `node "[^"]+claude-settings-doctor\.mjs" lint --project "[^"]+" --markdown`\]\n\nIn at most 10 lines: each problem with its settings file and line, and the fix\./);
    assert.ok(skillText.includes(`--project "${fwd(sb.work)}"`), "the project folder is filled in");
  } finally { await api.close(); }
});
