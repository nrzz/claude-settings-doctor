// write: the only code that writes. Backups next to the file, an atomic write that keeps the mode and follows a
// symlink, restore (which can itself be undone), and the record of the last build.
import { tmpDir } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_MARK, backupFile, backupPath, baselinePath, listBackups, ops, readBaseline, restoreBackup, stamp, writeAtomic, writeBaseline } from "../src/write.mjs";

const IS_WIN = process.platform === "win32";
const NOW = new Date(2026, 9, 16, 15, 30, 12); // local time: 2026-10-16 15:30:12

test("stamp: year, month, day, hour, minute and second in local time, as one sortable text", () => {
  assert.equal(stamp(NOW), "20261016-153012");
  assert.equal(stamp(new Date(2026, 0, 2, 3, 4, 5)), "20260102-030405");
  assert.ok(stamp() < "99999999-999999" && /^\d{8}-\d{6}$/.test(stamp()));
});

test("backupPath: the file, a mark and the stamp; a number is added when that name is taken", () => {
  const dir = tmpDir("csd-wr-");
  const file = path.join(dir, "settings.json");
  const first = backupPath(file, NOW);
  assert.equal(first, `${file}${BACKUP_MARK}20261016-153012`);
  fs.writeFileSync(first, "x");
  assert.equal(backupPath(file, NOW), `${first}-1`);
  fs.writeFileSync(`${first}-1`, "x");
  assert.equal(backupPath(file, NOW), `${first}-2`);
});

test("listBackups: oldest first, by stamp and then by number (not as text), and only this file's", () => {
  const dir = tmpDir("csd-wr-");
  const file = path.join(dir, "settings.json");
  for (const n of ["20261016-153012", "20261016-153012-1", "20261016-153012-10", "20261016-153012-2", "20261015-235959", "20261017-000000"]) fs.writeFileSync(`${file}${BACKUP_MARK}${n}`, n);
  fs.writeFileSync(path.join(dir, `settings.local.json${BACKUP_MARK}20261016-000000`), "other file");
  fs.writeFileSync(path.join(dir, "settings.json.bak"), "not ours");
  fs.writeFileSync(file, "now");
  assert.deepEqual(listBackups(file).map((n) => n.slice(`settings.json${BACKUP_MARK}`.length)), ["20261015-235959", "20261016-153012", "20261016-153012-1", "20261016-153012-2", "20261016-153012-10", "20261017-000000"]);
  assert.deepEqual(listBackups(path.join(dir, "nothing-here", "settings.json")), [], "a folder that is not there has no backups");
});

test("backupFile copies the bytes exactly: a byte-order mark, CRLF, and bytes that are not text", () => {
  const dir = tmpDir("csd-wr-");
  const file = path.join(dir, "settings.json");
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{\r\n  "a": "ü"\r\n}\r\n'), Buffer.from([0x00, 0xff, 0xfe])]);
  fs.writeFileSync(file, bytes);
  const made = backupFile(file, NOW);
  assert.ok(Buffer.compare(fs.readFileSync(made), bytes) === 0);
  assert.equal(path.dirname(made), dir, "next to the file");
});

test("writeAtomic: makes the folders, writes, leaves no temporary file", () => {
  const dir = tmpDir("csd-wr-");
  const file = path.join(dir, "a", "b", "settings.json");
  writeAtomic(file, '{"a": 1}\n');
  assert.equal(fs.readFileSync(file, "utf8"), '{"a": 1}\n');
  writeAtomic(file, "second\n");
  assert.equal(fs.readFileSync(file, "utf8"), "second\n");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["settings.json"]);
});

test("writeAtomic keeps the mode of the file it replaces", { skip: IS_WIN && "Windows has no file modes to keep" }, () => {
  const dir = tmpDir("csd-wr-");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "old");
  fs.chmodSync(file, 0o600);
  writeAtomic(file, "new");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("writeAtomic writes through a symlink to the file, and the link stays a link", (t) => {
  const dir = tmpDir("csd-wr-");
  const real = path.join(dir, "dotfiles", "settings.json");
  const link = path.join(dir, "home", "settings.json");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(real, "old");
  try { fs.symlinkSync(real, link, "file"); } catch (e) { t.skip(`no symlinks here (${e.code})`); return; }
  writeAtomic(link, "new");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "still a link");
  assert.equal(fs.readFileSync(real, "utf8"), "new", "the file it points to changed");
});

test("writeAtomic into a folder reached through a junction or a symlink", () => {
  const dir = tmpDir("csd-wr-");
  const real = path.join(dir, "real");
  const link = path.join(dir, "link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, "junction");
  writeAtomic(path.join(link, "settings.json"), "via link");
  assert.equal(fs.readFileSync(path.join(real, "settings.json"), "utf8"), "via link");
});

test("writeAtomic: a folder with spaces and non-ASCII letters", () => {
  const dir = tmpDir("csd wr ü-");
  const file = path.join(dir, "my config", "settings ü.json");
  writeAtomic(file, "text");
  assert.equal(fs.readFileSync(file, "utf8"), "text");
});

test("writeAtomic: when the rename cannot be done (another volume, a mount point) the text is written over the file in place", () => {
  const dir = tmpDir("csd-wr-");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "old");
  const real = ops.rename;
  try {
    for (const code of ["EXDEV", "EBUSY", "EPERM", "EACCES"]) {
      ops.rename = () => { throw Object.assign(new Error(code), { code }); };
      writeAtomic(file, `new via ${code}`);
      assert.equal(fs.readFileSync(file, "utf8"), `new via ${code}`);
      assert.deepEqual(fs.readdirSync(dir), ["settings.json"], `no temporary file after ${code}`);
    }
  } finally { ops.rename = real; }
});

test("writeAtomic: any other failure is raised, the file is as it was and no temporary file is left", () => {
  const dir = tmpDir("csd-wr-");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "old");
  const real = ops.rename;
  try {
    ops.rename = () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
    assert.throws(() => writeAtomic(file, "new"), /disk full/);
  } finally { ops.rename = real; }
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("restoreBackup: the newest backup comes back, and the file as it was is kept, so a restore can be undone", () => {
  const dir = tmpDir("csd-wr-");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "v1");
  const b1 = backupFile(file, new Date(2026, 9, 16, 10, 0, 0));
  fs.writeFileSync(file, "v2");
  const b2 = backupFile(file, new Date(2026, 9, 16, 11, 0, 0));
  fs.writeFileSync(file, "v3");
  const r = restoreBackup(file, { now: new Date(2026, 9, 16, 12, 0, 0) });
  assert.equal(r.restored, true);
  assert.equal(r.from, b2);
  assert.equal(r.others, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "v2");
  assert.equal(fs.readFileSync(r.savedCurrent, "utf8"), "v3", "what was there is saved");
  assert.ok(fs.existsSync(b1) && fs.existsSync(b2), "the backups it used stay");
  // restoring again takes the newest backup, which is the v3 just saved: the restore is undone
  const again = restoreBackup(file, { now: new Date(2026, 9, 16, 13, 0, 0) });
  assert.equal(fs.readFileSync(file, "utf8"), "v3");
  assert.equal(again.from, r.savedCurrent);
});

test("restoreBackup: --dry-run changes nothing, and no backup is a reason, not a crash", () => {
  const dir = tmpDir("csd-wr-");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "now");
  const none = restoreBackup(file, {});
  assert.equal(none.restored, false);
  assert.match(none.reason, /there is no backup of it/);
  backupFile(file, NOW);
  fs.writeFileSync(file, "changed");
  const dry = restoreBackup(file, { dryRun: true });
  assert.equal(dry.restored, false);
  assert.ok(dry.from);
  assert.equal(fs.readFileSync(file, "utf8"), "changed");
  assert.equal(listBackups(file).length, 1, "no backup was made");
});

test("restoreBackup: a file that is gone is restored too, and there is nothing to save", () => {
  const dir = tmpDir("csd-wr-");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "was here");
  backupFile(file, NOW);
  fs.rmSync(file);
  const r = restoreBackup(file, { now: NOW });
  assert.equal(r.restored, true);
  assert.equal(r.savedCurrent, null);
  assert.equal(fs.readFileSync(file, "utf8"), "was here");
});

test("the record of the last build: one per settings file, in the config folder, read back as it was written", () => {
  const cfg = tmpDir("csd-wr-");
  const a = path.join(cfg, "settings.json");
  const b = path.join(cfg, "other", "settings.json");
  assert.equal(readBaseline(cfg, a), null, "no record yet");
  writeBaseline(cfg, a, '{\r\n  "a": "ü"\r\n}\r\n', NOW);
  writeBaseline(cfg, b, '{"b": 1}', NOW);
  assert.equal(readBaseline(cfg, a), '{\r\n  "a": "ü"\r\n}\r\n', "byte for byte, also CRLF");
  assert.equal(readBaseline(cfg, b), '{"b": 1}');
  assert.notEqual(baselinePath(cfg, a), baselinePath(cfg, b));
  assert.ok(baselinePath(cfg, a).startsWith(path.join(cfg, "settings-doctor")));
  writeBaseline(cfg, a, "{}", NOW);
  assert.equal(readBaseline(cfg, a), "{}", "a new record replaces the old");
});

test("a record that is not ours, or is for another file, is no record", () => {
  const cfg = tmpDir("csd-wr-");
  const a = path.join(cfg, "settings.json");
  const other = path.join(cfg, "x", "settings.json");
  fs.mkdirSync(path.join(cfg, "settings-doctor"), { recursive: true });
  fs.writeFileSync(baselinePath(cfg, a), "not json at all");
  assert.equal(readBaseline(cfg, a), null);
  fs.writeFileSync(baselinePath(cfg, a), JSON.stringify({ version: 1, file: other, text: "{}" }));
  assert.equal(readBaseline(cfg, a), null, "the record names another file");
  fs.writeFileSync(baselinePath(cfg, a), JSON.stringify({ version: 1, file: a, text: 5 }));
  assert.equal(readBaseline(cfg, a), null, "the text is not text");
  fs.writeFileSync(baselinePath(cfg, a), "null");
  assert.equal(readBaseline(cfg, a), null);
});
