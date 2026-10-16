#!/usr/bin/env node
// Downloads SchemaStore's schema for Claude Code's settings into src/schema/. Run it by hand:
//
//   node scripts/update-schema.mjs              the schema and a record of where and when it came from
//   node scripts/update-schema.mjs --licence    also SchemaStore's licence text (Apache-2.0), once
//   node scripts/update-schema.mjs --out <dir>  write to another folder, to look at a new version first
//
// This is the only code in the repository that opens a network connection. claude-settings-doctor itself
// never does: it reads the copy in src/schema/, and says which download it used.
//
// The download is data. It is parsed as JSON and written as it arrived; nothing in it is run.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SCHEMA_URL = "https://json.schemastore.org/claude-code-settings.json";
const LICENCE_URL = "https://raw.githubusercontent.com/SchemaStore/schemastore/master/LICENSE";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const outIndex = args.indexOf("--out");
const outDir = path.resolve(outIndex >= 0 ? args[outIndex + 1] || "" : path.join(ROOT, "src", "schema"));
for (const a of args) if (!["--licence", "--out"].includes(a) && a !== args[outIndex + 1]) { console.error(`update-schema: unknown option ${a}`); process.exit(2); }
if (outIndex >= 0 && !args[outIndex + 1]) { console.error("update-schema: --out needs a folder"); process.exit(2); }

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { accept: "application/json, text/plain" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// The date on this machine (the day the person ran the script), not UTC.
function localDate(d = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

fs.mkdirSync(outDir, { recursive: true });
const schemaFile = path.join(outDir, "claude-code-settings.json");
const metaFile = path.join(outDir, "meta.json");

let before = null;
try { before = JSON.parse(fs.readFileSync(schemaFile, "utf8")); } catch { /* the first download */ }

const raw = await get(SCHEMA_URL);
let schema;
try { schema = JSON.parse(raw.toString("utf8")); } catch (e) { console.error(`update-schema: the download is not JSON (${e.message}); nothing was written`); process.exit(1); }
if (!schema || typeof schema !== "object" || typeof schema.properties !== "object" || schema.type !== "object") {
  console.error("update-schema: the download is not a JSON Schema for an object with properties; nothing was written");
  process.exit(1);
}

const text = raw.toString("utf8").endsWith("\n") ? raw.toString("utf8") : `${raw.toString("utf8")}\n`;
writeAtomic(schemaFile, text);
const meta = {
  source: SCHEMA_URL,
  downloaded: localDate(),
  bytes: Buffer.byteLength(text),
  sha256: crypto.createHash("sha256").update(text).digest("hex"),
  properties: Object.keys(schema.properties).length,
  licence: "Apache-2.0",
  licenceNote: "SchemaStore (https://github.com/SchemaStore/schemastore) is licensed under the Apache License 2.0; the text is in LICENSE next to this file.",
};
writeAtomic(metaFile, `${JSON.stringify(meta, null, 2)}\n`);

if (flag("--licence")) {
  const licence = await get(LICENCE_URL);
  if (!/Apache License/.test(licence.toString("utf8"))) { console.error("update-schema: the licence download is not the Apache License text; LICENSE was not written"); process.exit(1); }
  writeAtomic(path.join(outDir, "LICENSE"), licence);
  console.log(`wrote ${path.join(outDir, "LICENSE")}`);
}

console.log(`wrote ${schemaFile} (${meta.bytes} bytes, ${meta.properties} top-level properties, downloaded ${meta.downloaded})`);
if (before && before.properties) {
  const was = new Set(Object.keys(before.properties));
  const now = new Set(Object.keys(schema.properties));
  const added = [...now].filter((k) => !was.has(k));
  const removed = [...was].filter((k) => !now.has(k));
  console.log(`added: ${added.length ? added.join(", ") : "none"}`);
  console.log(`removed: ${removed.length ? removed.join(", ") : "none"}`);
}
