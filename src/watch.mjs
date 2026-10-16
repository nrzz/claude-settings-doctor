// watch: build once, then again every time settings.jsonc is saved. An editor may save by writing a new file and
// renaming it over the old one, so the folder is watched, not the file. Saves that come close together (many
// editors write twice) are one build. A build that is refused (a typo in settings.jsonc, a settings.json that
// changed since the last build) is reported and the watching goes on; settings.json is left as it was.
import fs from "node:fs";
import path from "node:path";
import { runBuild } from "./actions.mjs";
import { jsoncPath, targetFile } from "./settings.mjs";

/**
 * Watch the commented source of a settings file and build on every save.
 *   opts      what runBuild takes (target, project, env, home, platform, dryRun)
 *   onResult  called with each build's result and why it ran ("start" or "saved")
 *   signal    an AbortSignal that stops the watching
 *   poll      milliseconds between looks at the file, for a place where folder events do not arrive (0: use events)
 * Resolves when the signal fires. Rejects at once when the folder cannot be watched.
 */
export function watchBuild(opts, { onResult, signal, debounceMs = 120, poll = 0 }) {
  const target = targetFile(opts);
  const source = jsoncPath(target.path);
  const dir = path.dirname(source);
  const name = path.basename(source);
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(dir)) { reject(new Error(`the folder ${dir} does not exist, so there is nothing to watch`)); return; }
    let timer = null;
    let watcher = null;
    let stopped = false;
    const build = (why) => {
      if (stopped) return;
      let result;
      try { result = runBuild(opts); } catch (e) { result = { action: "build", ok: false, refused: e.message, lines: [], notes: [], file: target.path, source }; }
      onResult(result, why);
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => build("saved"), debounceMs); };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      if (watcher) watcher.close();
      if (poll) fs.unwatchFile(source);
      resolve();
    };
    try {
      if (poll) fs.watchFile(source, { interval: poll, persistent: true }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) schedule(); });
      else watcher = fs.watch(dir, { persistent: true }, (event, filename) => { if (!filename || filename.toString() === name) schedule(); });
    } catch (e) { reject(e); return; }
    if (signal) { if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true }); }
    build("start");
  });
}
