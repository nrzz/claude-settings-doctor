// watch: build once, then again on every save of settings.jsonc; a refused build is reported and the watching goes on.
import { world } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.mjs";
import { watchBuild } from "../src/watch.mjs";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await sleep(15); }
  assert.fail(`timed out waiting for ${what}`);
}
const jsoncOf = (w) => `${w.userFile}c`;
const optsOf = (w, extra = {}) => ({ target: "user", project: w.work, env: w.env, home: w.home, managed: w.managedDir, now: NOW, ...extra });

// Starts a watch; resolves { events, stop } with the build results as they arrive.
function start(w, { poll = 0, extra = {}, debounceMs = 25 } = {}) {
  const events = [];
  const controller = new AbortController();
  const done = watchBuild(optsOf(w, extra), { signal: controller.signal, poll, debounceMs, onResult: (result, why) => events.push({ why, result }) });
  return { events, done, stop: async () => { controller.abort(); await done; } };
}

const SRC = '{\n  // my model\n  "model": "opus", // pick\n}\n';

test("a build at the start, then one for each save; the build is the same as `build` makes", async () => {
  const w = world("watch");
  fs.writeFileSync(jsoncOf(w), SRC);
  const s = start(w);
  await waitFor(() => s.events.length >= 1, "the build at the start");
  assert.equal(s.events[0].why, "start");
  assert.equal(s.events[0].result.ok, true);
  assert.equal(w.read(w.userFile), '{\n  "model": "opus"\n}\n');
  fs.writeFileSync(jsoncOf(w), SRC.replace("opus", "sonnet"));
  await waitFor(() => s.events.some((e) => e.why === "saved"), "the build after a save");
  assert.equal(w.read(w.userFile), '{\n  "model": "sonnet"\n}\n');
  assert.equal(s.events.at(-1).result.ok, true);
  await s.stop();
});

test("saves that come close together are one build", async () => {
  const w = world("watch-debounce");
  fs.writeFileSync(jsoncOf(w), SRC);
  const s = start(w, { debounceMs: 150 });
  await waitFor(() => s.events.length >= 1, "the build at the start");
  for (let i = 0; i < 6; i++) { fs.writeFileSync(jsoncOf(w), SRC.replace("opus", `m${i}`)); await sleep(10); }
  await waitFor(() => s.events.some((e) => e.why === "saved"), "a build after the saves");
  await sleep(500);
  const saved = s.events.filter((e) => e.why === "saved").length;
  assert.ok(saved >= 1 && saved <= 2, `${saved} builds for 6 quick saves`);
  assert.equal(w.read(w.userFile), '{\n  "model": "m5"\n}\n', "the last save is the one built");
  await s.stop();
});

test("an editor that saves by writing a new file and renaming it over the old one is seen", async () => {
  const w = world("watch-rename");
  fs.writeFileSync(jsoncOf(w), SRC);
  const s = start(w);
  await waitFor(() => s.events.length >= 1, "the build at the start");
  const temp = path.join(w.claude, ".settings.jsonc.swp");
  fs.writeFileSync(temp, SRC.replace("opus", "haiku"));
  fs.renameSync(temp, jsoncOf(w));
  await waitFor(() => s.events.some((e) => e.why === "saved"), "the build after the rename");
  assert.equal(w.read(w.userFile), '{\n  "model": "haiku"\n}\n');
  await s.stop();
});

test("building writes settings.json, and that is not taken for a save of the source", async () => {
  const w = world("watch-loop");
  fs.writeFileSync(jsoncOf(w), SRC);
  const s = start(w);
  await waitFor(() => s.events.length >= 1, "the build at the start");
  await sleep(600);
  assert.equal(s.events.length, 1, "no build after the first");
  await s.stop();
});

test("a build that is refused is reported, settings.json is left alone, and the watching goes on", async () => {
  const w = world("watch-refused");
  fs.writeFileSync(jsoncOf(w), SRC);
  const s = start(w);
  await waitFor(() => s.events.length >= 1, "the build at the start");
  const good = w.read(w.userFile);
  fs.writeFileSync(jsoncOf(w), '{\n  "model": "x" "oops"\n}\n');
  await waitFor(() => s.events.some((e) => e.result.refused), "the refusal");
  const refused = s.events.find((e) => e.result.refused);
  assert.match(refused.result.refused, /settings\.jsonc cannot be built, line 2/);
  assert.equal(w.read(w.userFile), good);
  fs.writeFileSync(jsoncOf(w), SRC.replace("opus", "fixed"));
  await waitFor(() => s.events.at(-1).result.ok && s.events.length >= 3, "the build after the fix");
  assert.equal(w.read(w.userFile), '{\n  "model": "fixed"\n}\n');
  await s.stop();
});

test("a settings.json that Claude Code changed is not overwritten by a save, and the refusal says so", async () => {
  const w = world("watch-guard");
  fs.writeFileSync(jsoncOf(w), SRC);
  const s = start(w);
  await waitFor(() => s.events.length >= 1, "the build at the start");
  fs.writeFileSync(w.userFile, `${JSON.stringify({ model: "opus", theme: "dark" }, null, 2)}\n`);
  fs.writeFileSync(jsoncOf(w), SRC.replace("opus", "sonnet"));
  await waitFor(() => s.events.some((e) => e.result.refused), "the refusal");
  assert.match(s.events.find((e) => e.result.refused).result.refused, /building now would drop the changes made in settings\.json/);
  assert.equal(JSON.parse(w.read(w.userFile)).theme, "dark");
  await s.stop();
});

test("--dry-run: each build says what it would write and nothing is written", async () => {
  const w = world("watch-dry");
  fs.writeFileSync(jsoncOf(w), SRC);
  const s = start(w, { extra: { dryRun: true } });
  await waitFor(() => s.events.length >= 1, "the first report");
  assert.match(s.events[0].result.lines[0], /^Would write /);
  assert.equal(w.exists(w.userFile), false);
  await s.stop();
});

test("the signal stops it: the promise resolves, and a save after that builds nothing", async () => {
  const w = world("watch-stop");
  fs.writeFileSync(jsoncOf(w), SRC);
  const s = start(w);
  await waitFor(() => s.events.length >= 1, "the build at the start");
  await s.stop();
  const count = s.events.length;
  fs.writeFileSync(jsoncOf(w), SRC.replace("opus", "after"));
  await sleep(400);
  assert.equal(s.events.length, count);
  assert.equal(w.read(w.userFile), '{\n  "model": "opus"\n}\n');
  // a signal that is already aborted stops it at once
  const controller = new AbortController();
  controller.abort();
  const seen = [];
  await watchBuild(optsOf(w), { signal: controller.signal, onResult: (r, why) => seen.push(why) });
  assert.deepEqual(seen, [], "nothing is built when it is stopped before it starts");
});

test("a folder that is not there cannot be watched, and the reason is said", async () => {
  const w = world("watch-nofolder");
  await assert.rejects(watchBuild(optsOf(w, { project: path.join(w.base, "nowhere") , target: "project" }), { signal: new AbortController().signal, onResult: () => {} }), /the folder .* does not exist, so there is nothing to watch/);
});

test("--poll: a save is seen by looking at the file, for a place where folder events do not arrive", async () => {
  const w = world("watch-poll");
  fs.writeFileSync(jsoncOf(w), SRC);
  const s = start(w, { poll: 50 });
  await waitFor(() => s.events.length >= 1, "the build at the start");
  await sleep(120);
  fs.writeFileSync(jsoncOf(w), SRC.replace("opus", "polled-longer-value"));
  await waitFor(() => s.events.some((e) => e.why === "saved"), "the build after a save", 10000);
  assert.equal(w.read(w.userFile), '{\n  "model": "polled-longer-value"\n}\n');
  await s.stop();
});

// ---- through the command line ------------------------------------------------------------------------------------

async function cli(argv, w, { stopWhen, ms = 8000 } = {}) {
  const controller = new AbortController();
  let out = "";
  let err = "";
  const done = main(argv, {
    cwd: w.work, env: w.env, home: w.home, managed: w.managedDir, signal: controller.signal,
    stdout: { write: (s) => { out += s; return true; }, isTTY: false },
    stderr: { write: (s) => { err += s; return true; } },
  });
  await waitFor(() => stopWhen(out), "the output", ms);
  controller.abort();
  const code = await done;
  return { code, out, err };
}

test("watch --user: says what it watches, reports each build with the time, and exits 0 when stopped", async () => {
  const w = world("watch-cli");
  fs.writeFileSync(jsoncOf(w), SRC);
  const controller = new AbortController();
  let out = "";
  const done = main(["watch", "--user"], { cwd: w.work, env: w.env, home: w.home, managed: w.managedDir, signal: controller.signal, stdout: { write: (s) => { out += s; return true; }, isTTY: false }, stderr: { write: () => true } });
  await waitFor(() => /built at start/.test(out), "the first build");
  fs.writeFileSync(jsoncOf(w), SRC.replace("opus", "cli"));
  await waitFor(() => /saved: /.test(out), "the second build");
  controller.abort();
  assert.equal(await done, 0);
  assert.match(out, /^Watching the source of the user's settings: waiting for saves\. Ctrl\+C stops\.\n/);
  assert.match(out, /\[\d\d:\d\d:\d\d\] built at start: Wrote /);
  assert.match(out, /\[\d\d:\d\d:\d\d\] saved: Wrote /);
});

test("watch --json: one JSON document per line, each with its event", async () => {
  const w = world("watch-json");
  fs.writeFileSync(jsoncOf(w), SRC);
  const r = await cli(["watch", "--user", "--json"], w, { stopWhen: (o) => o.trim().split("\n").filter(Boolean).length >= 1 });
  assert.equal(r.code, 0);
  const first = JSON.parse(r.out.trim().split("\n")[0]);
  assert.equal(first.event, "start");
  assert.equal(first.action, "build");
  assert.equal(first.ok, true);
});

test("watch exits 1 when the first build is refused, after it is stopped", async () => {
  const w = world("watch-cli-refused", { user: { model: "other" } });
  fs.writeFileSync(jsoncOf(w), SRC);
  // a record of an earlier build that settings.json no longer matches
  await main(["build", "--user", "--force"], { cwd: w.work, env: w.env, home: w.home, managed: w.managedDir, now: NOW, stdout: { write: () => true }, stderr: { write: () => true } });
  fs.writeFileSync(w.userFile, `${JSON.stringify({ model: "changed by claude" }, null, 2)}\n`);
  const r = await cli(["watch", "--user"], w, { stopWhen: (o) => /refused/.test(o) });
  assert.equal(r.code, 1);
  assert.match(r.out, /built at start: refused: building now would drop the changes made in settings\.json/);
});

test("watch needs the file named, and a folder that exists", async () => {
  const w = world("watch-cli-bad");
  let err = "";
  const code = await main(["watch"], { cwd: w.work, env: w.env, home: w.home, managed: w.managedDir, stdout: { write: () => true }, stderr: { write: (s) => { err += s; return true; } } });
  assert.equal(code, 2);
  assert.match(err, /watch needs the settings file/);
  const missing = await main(["watch", "--project", path.join(w.base, "nowhere")], { cwd: w.work, env: w.env, home: w.home, managed: w.managedDir, stdout: { write: () => true }, stderr: { write: (s) => { err += s; return true; } } });
  assert.equal(missing, 1);
  assert.match(err, /does not exist, so there is nothing to watch/);
});
