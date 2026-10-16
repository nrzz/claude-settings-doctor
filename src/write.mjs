// The only code that writes. A settings file is the user's: every write backs the file up first (next to it,
// named <file>.bak-settings-doctor-<timestamp>), goes through a temporary file and a rename so that nobody sees
// half of it, keeps the file's mode, and follows a symlink to the file instead of replacing the link.
// `restore` puts a backup back. Besides the settings files, one small record per settings file is kept in
// <config folder>/settings-doctor/: the text of settings.json as of the last build, absorb or init, which is
// how absorb tells what Claude Code changed from what you did.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The file operations that matter, in one place. Tests swap them to make a rename fail.
export const ops = { rename: (from, to) => fs.renameSync(from, to) };

const two = (n) => String(n).padStart(2, "0");

/** 20261016-153012 in local time, used in backup names. */
export function stamp(d = new Date()) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

export const BACKUP_MARK = ".bak-settings-doctor-";

/** <file>.bak-settings-doctor-<timestamp>, or with -1, -2 ... when that name is taken. */
export function backupPath(file, now = new Date()) {
  const base = `${file}${BACKUP_MARK}${stamp(now)}`;
  if (!exists(base)) return base;
  for (let i = 1; i < 1000; i++) if (!exists(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

/** The names of the backups of a file, oldest first. */
export function listBackups(file) {
  const prefix = `${path.basename(file)}${BACKUP_MARK}`;
  try {
    return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(prefix)).sort((a, b) => {
      // the stamp, then the -n suffix as a number
      const [sa, na = "0"] = a.slice(prefix.length).split(/-(?=\d+$)/);
      const [sb, nb = "0"] = b.slice(prefix.length).split(/-(?=\d+$)/);
      return sa < sb ? -1 : sa > sb ? 1 : Number(na) - Number(nb);
    });
  } catch { return []; }
}

/** Where the bytes of a file really are: a symlink is followed, so the link stays a link. */
function realTarget(file) {
  try { return fs.realpathSync(file); } catch { return file; }
}

/**
 * Write text to a file through a temporary file in the same folder and a rename. The mode of an existing file is
 * kept. When the rename cannot be done (a file that is a mount point, a folder on another volume: EXDEV, EBUSY,
 * EPERM), the text is written over the file in place instead.
 */
export function writeAtomic(file, text) {
  const target = realTarget(file);
  let mode = null;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* a new file */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tmp, text);
  if (mode !== null) { try { fs.chmodSync(tmp, mode); } catch { /* the file system has no modes */ } }
  try {
    ops.rename(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    if (!e || !["EXDEV", "EBUSY", "EPERM", "EACCES"].includes(e.code)) throw e;
    fs.writeFileSync(target, text);
  }
}

/** Copy a file to its backup name. Returns the backup's path. */
export function backupFile(file, now = new Date()) {
  const to = backupPath(file, now);
  fs.copyFileSync(file, to);
  return to;
}

/**
 * Put the newest backup of a file back. The file as it is now is backed up first, so this can be undone too.
 * Returns { restored, path, from, savedCurrent, others } or { restored: false, reason }.
 */
export function restoreBackup(file, { now = new Date(), dryRun = false } = {}) {
  const names = listBackups(file);
  if (!names.length) return { restored: false, path: file, reason: `there is no backup of it (they are named <file>${BACKUP_MARK}<timestamp>)` };
  const from = path.join(path.dirname(file), names[names.length - 1]);
  const result = { restored: !dryRun, path: file, from, savedCurrent: null, others: names.length - 1, dryRun };
  if (dryRun) return result;
  if (exists(file)) result.savedCurrent = backupFile(file, now);
  writeAtomic(file, fs.readFileSync(from));
  return result;
}

// ------------------------------------------------------------------------------------------------------------
// the record of the last build
// ------------------------------------------------------------------------------------------------------------

const baselineName = (settingsFile) => `baseline-${crypto.createHash("sha256").update(path.resolve(settingsFile)).digest("hex").slice(0, 16)}.json`;

/** Where the record for a settings file lives, inside the config folder. */
export const baselinePath = (configDir, settingsFile) => path.join(configDir, "settings-doctor", baselineName(settingsFile));

/** The text of settings.json as of the last build, absorb or init, or null when there is no record. */
export function readBaseline(configDir, settingsFile) {
  try {
    const rec = JSON.parse(fs.readFileSync(baselinePath(configDir, settingsFile), "utf8"));
    if (rec && typeof rec.text === "string" && rec.file === path.resolve(settingsFile)) return rec.text;
  } catch { /* none, or not ours */ }
  return null;
}

export function writeBaseline(configDir, settingsFile, text, now = new Date()) {
  const rec = { version: 1, file: path.resolve(settingsFile), savedAt: now.toISOString(), text };
  writeAtomic(baselinePath(configDir, settingsFile), `${JSON.stringify(rec, null, 2)}\n`);
}
