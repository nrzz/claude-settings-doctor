// The command line as a whole: the options each command takes, the exit codes (0 ok, 1 findings or a refusal, 2 a
// usage error), help and version, JSON for errors, colour, and the entry file.
import { CLI, ROOT, run, runCli, tmpDir, world } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// ---- parseArgs -------------------------------------------------------------------------------------------------

test("parseArgs: a command, its arguments and the options it takes", () => {
  const o = parseArgs(["lint", "--project", "dir", "--file", "x.jsonc", "--markdown", "--no-color"]);
  assert.equal(o.command, "lint");
  assert.equal(o.project, "dir");
  assert.equal(o.file, "x.jsonc");
  assert.equal(o.markdown, true);
  assert.equal(o.noColor, true);
  assert.deepEqual(parseArgs(["explain", "permissions.defaultMode"]).positional, ["permissions.defaultMode"]);
  const w = parseArgs(["build", "--user", "--dry-run", "--force"]);
  assert.deepEqual([w.user, w.dryRun, w.force], [true, true, true]);
  const r = parseArgs(["restore", "--local", "--jsonc", "--list"]);
  assert.deepEqual([r.local, r.jsonc, r.list], [true, true, true]);
  assert.equal(parseArgs(["watch", "--user", "--poll", "250"]).poll, 250);
});

test("parseArgs: an option may be written --name=value, and the options may come before the command", () => {
  const o = parseArgs(["--project=some dir", "--json", "show"]);
  assert.equal(o.command, "show");
  assert.equal(o.project, "some dir");
  assert.equal(o.json, true);
  assert.equal(parseArgs(["watch", "--poll=100", "--user"]).poll, 100);
  assert.equal(parseArgs(["lint", "--file=a=b.json"]).file, "a=b.json", "only the first = separates");
  assert.equal(parseArgs(["show", "--only=permissions"]).only, "permissions");
  assert.equal(parseArgs(["show", "--only", "permissions.defaultMode"]).only, "permissions.defaultMode");
});

test("parseArgs: only the first command word is the command; a later one is an argument", () => {
  const o = parseArgs(["explain", "show"]);
  assert.equal(o.command, "explain");
  assert.deepEqual(o.positional, ["show"]);
  assert.equal(parseArgs(["frobnicate"]).command, null);
  assert.deepEqual(parseArgs(["frobnicate"]).positional, ["frobnicate"]);
});

test("parseArgs: what it refuses", () => {
  const bad = (argv, message) => assert.throws(() => parseArgs(argv), (e) => e.constructor.name === "UsageError" && message.test(e.message), argv.join(" "));
  bad(["show", "--nope"], /unknown option --nope/);
  bad(["show", "-x"], /unknown option -x/);
  bad(["lint", "--project"], /--project needs a folder \(use --project \. for the current folder\)/);
  bad(["lint", "--project", "--json"], /--project needs a folder/);
  bad(["lint", "--file"], /--file needs a value/);
  bad(["lint", "--file", "-x"], /--file needs a value/);
  bad(["show", "--json=1"], /--json does not take a value/);
  bad(["watch", "--poll", "10"], /--poll needs a number of milliseconds, 50 or more/);
  bad(["watch", "--poll", "fast"], /--poll needs a number of milliseconds/);
  bad(["watch", "--poll"], /--poll needs a value/);
  bad(["show", "--only"], /--only needs a key/);
  bad(["show", "--only", "--json"], /--only needs a key/);
  bad(["show", "--only="], /--only needs a key/);
  bad(["show", "--only", "   "], /--only needs a key/);
  bad(["lint", "--json", "--markdown"], /--json and --markdown cannot be combined/);
});

test("parseArgs: a lone dash is an argument, not an option", () => {
  assert.deepEqual(parseArgs(["explain", "-"]).positional, ["-"]);
});

// ---- exit codes, in process ------------------------------------------------------------------------------------

test("no command, an unknown command and a missing key are usage errors, exit 2, with a hint", async () => {
  const w = world("usage");
  const none = await run([], w);
  assert.equal(none.code, 2);
  assert.match(none.err, /^claude-settings-doctor: a command is needed\nTry: claude-settings-doctor --help\n$/);
  const unknown = await run(["frobnicate"], w);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown command frobnicate/);
  const key = await run(["explain"], w);
  assert.equal(key.code, 2);
  assert.match(key.err, /explain needs one key, as in: explain permissions\.defaultMode/);
  assert.equal((await run(["explain", "a", "b"], w)).code, 2);
  assert.equal(none.out, "", "nothing on stdout");
});

test("the options a command does not take are refused by name", async () => {
  const w = world("wrongflags");
  const cases = [
    [["show", "--user"], /--user does not belong to show/],
    [["show", "--markdown"], /--markdown does not belong to show/],
    [["lint", "--force"], /--force does not belong to lint/],
    [["lint", "--user"], /--user does not belong to lint/],
    [["explain", "key", "--dry-run"], /--dry-run does not belong to explain/],
    [["init", "--user", "--jsonc"], /--jsonc does not belong to init/],
    [["init", "--user", "--list"], /--list does not belong to init/],
    [["build", "--user", "--poll", "100"], /--poll does not belong to build/],
    [["build", "--user", "--file", "x"], /--file does not belong to build/],
    [["check", "--user", "--dry-run"], /--dry-run does not belong to check/],
    [["check", "--user", "--force"], /--force does not belong to check/],
    [["absorb", "--user", "--force"], /--force does not belong to absorb/],
    [["restore", "--user", "--force"], /--force does not belong to restore/],
    [["lint", "--only", "key"], /--only does not belong to lint/],
    [["explain", "key", "--only", "key"], /--only does not belong to explain/],
    [["build", "--user", "--only", "key"], /--only does not belong to build/],
  ];
  for (const [argv, message] of cases) {
    const r = await run(argv, w);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, message, argv.join(" "));
  }
});

test("a writing command needs to be told the file: --user, --project <dir> or --local, and not two of them", async () => {
  const w = world("target");
  for (const cmd of ["init", "build", "check", "absorb", "restore", "watch"]) {
    const r = await run([cmd], w);
    assert.equal(r.code, 2, cmd);
    assert.match(r.err, new RegExp(`${cmd} needs the settings file: --user, --project <dir> or --local`));
  }
  assert.match((await run(["build", "--user", "--local"], w)).err, /choose one settings file: --user or --local, not both/);
  assert.match((await run(["build", "--user", "--project", "."], w)).err, /--user is the user's file in the Claude config folder; it does not take --project/);
  assert.match((await run(["build", "--project"], w)).err, /--project needs a folder/);
});

test("arguments that no command takes are refused: show, lint, build and restore take none", async () => {
  const w = world("args");
  assert.match((await run(["show", "extra"], w)).err, /show takes no arguments \(got "extra"\)/);
  assert.match((await run(["lint", "extra"], w)).err, /lint takes no arguments \(got "extra"\)/);
  assert.match((await run(["build", "--user", "extra"], w)).err, /build takes no arguments \(got "extra"\)/);
  assert.match((await run(["restore", "--user", "extra"], w)).err, /restore takes no arguments; name the file with --user, --project <dir> or --local/);
});

test("--json: a usage error is a JSON document on stdout, exit 2, nothing on stderr", async () => {
  const w = world("jsonerr");
  const r = await run(["show", "--user", "--json"], w);
  assert.equal(r.code, 2);
  assert.deepEqual(r.json(), { ok: false, error: "--user does not belong to show" });
  assert.equal(r.err, "");
  const a = await run(["--json"], w);
  assert.deepEqual(a.json(), { ok: false, error: "a command is needed" });
  const c = await run(["lint", "--json", "--markdown"], w);
  assert.equal(c.json().ok, false);
});

test("help and version: exit 0, whatever else was typed; every command and option is in the help", async () => {
  const w = world("help");
  const help = await run(["--help"], w);
  assert.equal(help.code, 0);
  for (const word of ["show", "lint", "explain", "init", "build", "check", "absorb", "watch", "restore", "--user", "--project", "--local", "--dry-run", "--force", "--json", "--markdown", "--file", "--poll", "--jsonc", "--list", "--no-color", "--version", "CLAUDE_CONFIG_DIR", "Exit codes"]) assert.ok(help.out.includes(word), word);
  assert.match(help.out, /^claude-settings-doctor \d+\.\d+\.\d+\nComments for your Claude Code settings/);
  assert.equal((await run(["-h"], w)).out, help.out);
  assert.equal((await run(["show", "--bogus", "--help"], w)).code, 2, "an unknown option is still an error");
  assert.equal((await run(["frobnicate", "--help"], w)).code, 0, "help wins over an unknown command");
  const v = await run(["--version"], w);
  assert.equal(v.code, 0);
  assert.equal(v.out, `${VERSION}\n`);
  assert.equal((await run(["-v"], w)).out, `${VERSION}\n`);
  assert.equal(VERSION, pkg.version);
});

test("the help lines are no wider than 100 columns and have no emoji", async () => {
  const help = (await run(["--help"], world("helpwidth"))).out;
  for (const line of help.split("\n")) assert.ok(line.length <= 100, `${line.length}: ${line}`);
  assert.ok(!/\p{Extended_Pictographic}/u.test(help));
});

test("exit codes: show 0; lint 1 when there is an error or a warning, 0 when not; explain 1 for a key the schema lacks", async () => {
  const clean = world("exit-clean", { user: { model: "m" } });
  assert.equal((await run(["show"], clean)).code, 0);
  assert.equal((await run(["lint"], clean)).code, 0);
  assert.equal((await run(["explain", "model"], clean)).code, 0);
  assert.equal((await run(["explain", "nokey"], clean)).code, 1);
  const warn = world("exit-warn", { user: { notAKey: 1 } });
  assert.equal((await run(["lint"], warn)).code, 1, "a warning is enough");
  const error = world("exit-error", { user: { model: 5 } });
  assert.equal((await run(["lint"], error)).code, 1);
  const note = world("exit-note");
  fs.writeFileSync(note.userFile, "");
  assert.equal((await run(["lint"], note)).code, 0, "a note alone is not a finding");
  assert.equal((await run(["show"], error)).code, 0, "show reports; it does not judge");
});

test("lint --markdown exits 0 whatever it finds: Claude Code drops a skill whose command fails", async () => {
  const w = world("exit-markdown", { user: { model: 5, notAKey: 1 } });
  const r = await run(["lint", "--markdown"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /^## settings-doctor lint: /);
  assert.match(r.out, /ERROR `wrong-type`/);
  assert.equal((await run(["lint", "--markdown", "--file", path.join(w.base, "nope.json")], w)).code, 0);
  assert.equal((await run(["lint", "--json"], w)).code, 1, "--json keeps the exit code");
});

test("the project folder is --project, else the folder the command runs in; a relative one is relative to that", async () => {
  const w = world("project", { project: { model: "from-project" } });
  const here = await run(["show", "--json"], w);
  assert.equal(here.json().project, w.work);
  assert.equal(here.json().tree.model, "from-project");
  const other = world("project-other", { project: { model: "elsewhere" } });
  const there = await run(["show", "--json", "--project", other.work], w);
  assert.equal(there.json().project, other.work);
  assert.equal(there.json().tree.model, "elsewhere");
  const rel = await run(["show", "--json", "--project", path.relative(w.work, other.work)], w);
  assert.equal(rel.json().project, other.work);
});

test("colour: only on a terminal, and not with --no-color or NO_COLOR", async () => {
  const w = world("color", { user: { model: 5 } });
  const on = await run(["lint"], w, { tty: true, env: { NO_COLOR: "" } });
  assert.match(on.out, /\x1b\[3\dm/);
  assert.doesNotMatch((await run(["lint"], w, { tty: true, env: { NO_COLOR: "" } })).out.replace(/\x1b\[[0-9;]*m/g, ""), /\x1b/);
  assert.doesNotMatch((await run(["lint", "--no-color"], w, { tty: true, env: { NO_COLOR: "" } })).out, /\x1b/);
  assert.doesNotMatch((await run(["lint"], w, { tty: true, env: { NO_COLOR: "1" } })).out, /\x1b/);
  assert.doesNotMatch((await run(["lint"], w, { tty: false, env: { NO_COLOR: "" } })).out, /\x1b/, "a pipe gets no colour");
  assert.doesNotMatch((await run(["lint", "--json"], w, { tty: true, env: { NO_COLOR: "" } })).out, /\x1b/, "JSON never has colour");
});

test("an unexpected error is an exit 2 with the message, not a stack trace", async () => {
  const w = world("unexpected", { user: { model: "m" } });
  const r = await main2(["show"], { stdout: { write: () => { throw new Error("the disk is gone"); }, isTTY: false } }, w);
  assert.equal(r.code, 2);
  assert.match(r.err, /claude-settings-doctor: the disk is gone/);
  assert.doesNotMatch(r.err, /\n\s+at /);
});

import { main } from "../src/cli.mjs";
async function main2(args, io, w) {
  let err = "";
  const code = await main(args, { cwd: w.work, env: w.env, home: w.home, managed: w.managedDir, stderr: { write: (s) => { err += s; return true; } }, ...io });
  return { code, err };
}

// ---- the entry file, as a process --------------------------------------------------------------------------------

test("bin: a process prints the same, with the same exit codes", () => {
  const w = world("bin", { user: { model: "m", notAKey: 1 } });
  const v = runCli(["--version"], { env: w.env, cwd: w.work });
  assert.equal(v.code, 0);
  assert.equal(v.out, `${VERSION}\n`);
  const lint = runCli(["lint", "--json"], { env: w.env, cwd: w.work });
  assert.equal(lint.code, 1);
  assert.equal(JSON.parse(lint.out).counts.warning, 1);
  const bad = runCli(["nope"], { env: w.env, cwd: w.work });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown command nope/);
  assert.equal(bad.out, "");
});

test("bin: the first line is a node shebang (npm makes the file executable from package.json's bin)", () => {
  assert.match(fs.readFileSync(CLI, "utf8"), /^#!\/usr\/bin\/env node\r?\n/);
  assert.equal(pkg.bin["claude-settings-doctor"], "bin/claude-settings-doctor.mjs");
});

test("bin: a reader that goes away early (| head) is not an error", async () => {
  const w = world("epipe");
  const env = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`KEY_NUMBER_${i}`, `value ${i}`]));
  w.user({ env });
  const child = spawn(process.execPath, [CLI, "show"], { cwd: w.work, env: w.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const done = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  try {
    await new Promise((resolve) => child.stdout.once("data", resolve));
    child.stdout.destroy();
    assert.equal(await done, 0);
  } finally { child.kill(); }
});

test("runCli refuses to run against a folder outside the temporary folder", () => {
  assert.throws(() => runCli(["show"], { env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(path.parse(process.cwd()).root, "somewhere", ".claude") } }), /needs an environment from world\(\)/);
});

test("the process the tests run in has its home and config pointed at a temporary folder", () => {
  const tmp = fs.realpathSync(tmpDir("csd-check-")).toLowerCase();
  const root = path.dirname(tmp);
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR"]) assert.ok(path.resolve(process.env[k]).toLowerCase().startsWith(root), `${k}=${process.env[k]}`);
});
