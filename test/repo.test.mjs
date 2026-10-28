// The package itself: what it says it is, what it imports, which Node it needs, that nothing in it starts a process or
// opens a socket, that the plugin's skill calls the tool with options the tool has, that the icon is a real PNG of the
// right size, that the workflows and the README have what they promise, and that the version is the same everywhere.
import { ROOT, run, world } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";
import { loadSchema } from "../src/schema.mjs";

// a checkout on Windows may turn line feeds into CRLF
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const json = (rel) => JSON.parse(read(rel));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const files = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n));

const pkg = json("package.json");
const plugin = json(".claude-plugin/plugin.json");

test("package.json: name, version, bin, engines, no dependencies, tests run with node --test, the files that are shipped", () => {
  assert.equal(pkg.name, "claude-settings-doctor");
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.bin, { "claude-settings-doctor": "bin/claude-settings-doctor.mjs" });
  assert.equal(pkg.engines.node, ">=18");
  for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) assert.equal(pkg[k], undefined, k);
  assert.equal(pkg.scripts.test, "node --test");
  assert.deepEqual(pkg.files, ["bin", "src", ".claude-plugin", "skills", "README.md", "LICENSE"]);
  for (const f of pkg.files) assert.ok(exists(f), `${f} is listed and exists`);
  assert.match(pkg.description, /^Comments for your Claude Code settings/);
  assert.match(pkg.description, /Zero tokens\.$/);
  assert.equal(pkg.repository, "github:nrzz/claude-settings-doctor");
  assert.equal(pkg.homepage, "https://github.com/nrzz/claude-settings-doctor#readme");
  assert.equal(pkg.bugs, "https://github.com/nrzz/claude-settings-doctor/issues");
  assert.equal(pkg.author, "Naresh Prabu");
  for (const k of ["claude", "claude-code", "settings", "jsonc", "json-schema", "linter"]) assert.ok(pkg.keywords.includes(k), k);
});

test("no lock file, no vendored node_modules, and no .gitattributes (the plugin directory cannot validate a repository that has one)", () => {
  assert.ok(!exists("package-lock.json"));
  assert.ok(!exists("npm-shrinkwrap.json"));
  assert.ok(!exists("yarn.lock"));
  assert.ok(!exists("node_modules") || fs.readdirSync(path.join(ROOT, "node_modules")).length === 0);
  assert.ok(!exists(".gitattributes"));
  assert.match(read(".gitignore"), /^node_modules\/$/m);
});

test("the plugin manifest matches the package", () => {
  assert.equal(plugin.name, "settings-doctor");
  assert.equal(plugin.displayName, "Settings Doctor");
  assert.equal(plugin.version, VERSION);
  assert.equal(plugin.license, "MIT");
  assert.deepEqual(plugin.author, { name: "Naresh Prabu" });
  assert.equal(plugin.homepage, "https://github.com/nrzz/claude-settings-doctor");
  assert.equal(plugin.repository, "https://github.com/nrzz/claude-settings-doctor");
  assert.equal(plugin.documentationUrl, "https://github.com/nrzz/claude-settings-doctor#readme");
  assert.equal(plugin.supportUrl, "https://github.com/nrzz/claude-settings-doctor/issues");
  assert.equal(plugin.privacyPolicyUrl, "https://github.com/nrzz/claude-settings-doctor#privacy");
  assert.equal(plugin.termsOfServiceUrl, "https://github.com/nrzz/claude-settings-doctor/blob/main/LICENSE");
  assert.ok(plugin.keywords.length >= 4);
  assert.match(plugin.description, /\/settings-doctor:check/);
  assert.equal(plugin.hooks, undefined, "no hooks: the plugin is one skill");
  assert.equal(plugin.mcpServers, undefined);
  assert.ok(!exists("hooks"), "a settings tool adds no hook of its own");
  assert.ok(!exists("agents") && !exists("commands"));
});

test("the icon is a real PNG, 1024 by 1024, as the other plugins' are", () => {
  const png = fs.readFileSync(path.join(ROOT, ".claude-plugin", "icon.png"));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "the PNG signature");
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 1024, "width");
  assert.equal(png.readUInt32BE(20), 1024, "height");
  assert.ok(png.length > 2000 && png.length < 500000, `${png.length} bytes`);
  assert.equal(png.toString("ascii", png.length - 8, png.length - 4), "IEND");
});

test("one skill, /settings-doctor:check: user-only, a description of five words, allowed to run this tool and nothing wider", () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "skills")), ["check"]);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "skills", "check")), ["SKILL.md"]);
  const text = read("skills/check/SKILL.md");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(front, "has frontmatter");
  assert.match(front[1], /^name: check$/m);
  assert.match(front[1], /^disable-model-invocation: true$/m);
  const desc = /^description: (.+)$/m.exec(front[1])[1];
  assert.equal(desc, "Check settings files.", "the hub's twelve plugins share an always-on limit of 200 tokens");
  assert.ok(desc.length <= 40, `${desc.length} characters`);
  const allowed = /^allowed-tools: (.+)$/m.exec(front[1])[1];
  const rules = allowed.split(/\s(?=(?:Bash|PowerShell)\()/);
  assert.equal(rules.length, 4);
  for (const rule of rules) assert.match(rule, /^(Bash|PowerShell)\(node "?\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-settings-doctor\.mjs"? \*\)$/, rule);
  assert.ok(rules.some((r) => r.startsWith("Bash(")) && rules.some((r) => r.startsWith("PowerShell(")), "for whichever shell tool Claude Code has");
  assert.doesNotMatch(allowed, /Bash\(\*\)|Edit|Write|WebFetch/, "nothing wider than the one command");
});

test("the skill runs lint --markdown for the project, once, and asks for at most 10 lines and no edit before the user agrees", () => {
  const text = read("skills/check/SKILL.md");
  const body = text.slice(/^---\n[\s\S]*?\n---\n/.exec(text)[0].length);
  const commands = [...body.matchAll(/^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-settings-doctor\.mjs" (.+)`$/gm)].map((m) => m[1]);
  assert.equal(commands.length, 1, "one command line, which Claude Code runs or hands to the model");
  const parsed = parseArgs(commands[0].replace(/"\$\{CLAUDE_PROJECT_DIR\}"/g, "dir").split(/\s+/));
  assert.equal(parsed.command, "lint");
  assert.equal(parsed.markdown, true);
  assert.equal(parsed.project, "dir");
  assert.match(body, /In at most 10 lines: each problem with its settings file and line, and the fix\./);
  assert.match(body, /If there are no findings, say so in one line\./);
  assert.match(body, /Edit nothing until the user agrees\./);
  assert.ok(!/\$\{CLAUDE_SKILL_DIR\}|\$ARGUMENTS/.test(body));
  assert.ok(body.length < 600, `the instructions are ${body.length} characters; each use pays for them`);
});

test("every source file is .mjs and imports only node built-ins and the package itself; nothing starts a process or opens a socket", () => {
  const sources = [...files("src", ".mjs"), ...files("bin", ".mjs")];
  assert.ok(sources.length >= 18);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "src")).filter((n) => !n.endsWith(".mjs") && n !== "schema"), []);
  const allowed = new Set(["node:crypto", "node:fs", "node:os", "node:path"]);
  for (const f of sources) {
    const text = read(f);
    for (const m of text.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)) {
      const spec = m[1];
      assert.ok(spec.startsWith("./") || spec.startsWith("../") || allowed.has(spec), `${f} imports ${spec}`);
    }
    assert.doesNotMatch(text, /\brequire\(|\bimport\(/, `${f} has no dynamic loading`);
  }
});

test("nothing in the package can reach the network or start another program", () => {
  const banned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|node:(http|https|http2|net|tls|dns|dgram|worker_threads|cluster|vm|child_process)\b|\bprocess\.binding\b|\beval\s*\(|new Function\s*\(/;
  for (const f of [...files("src", ".mjs"), ...files("bin", ".mjs")]) assert.doesNotMatch(read(f), banned, f);
});

test("src/write.mjs is the only code that writes: nothing else in the package calls a function that changes a file", () => {
  const writes = /\b(?:writeFile|appendFile|copyFile|rename|unlink|rmdir|rm|mkdir|truncate|symlink|link|chmod|utimes)(?:Sync)?\s*\(|\bcreateWriteStream\b|\bfs\.promises\b/;
  for (const f of [...files("src", ".mjs"), ...files("bin", ".mjs")]) {
    if (f.split(path.sep).join("/") === "src/write.mjs") continue;
    assert.doesNotMatch(read(f), writes, `${f} must not write: only src/write.mjs does`);
  }
  assert.match(read("src/write.mjs"), /fs\.writeFileSync/);
});

test("scripts/update-schema.mjs is the one place that uses the network, and it is not shipped", () => {
  const text = read("scripts/update-schema.mjs");
  assert.match(text, /\bfetch\(/);
  assert.ok(!pkg.files.includes("scripts"));
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "scripts")), ["update-schema.mjs"]);
});

test("only APIs that exist in Node 18 are used", () => {
  const newer = [
    [/\.toSorted\(|\.toReversed\(|\.toSpliced\(|\.with\(\d/, "Array copy-methods (Node 20)"],
    [/\bObject\.groupBy\b|\bMap\.groupBy\b/, "groupBy (Node 21)"],
    [/\bArray\.fromAsync\b/, "Array.fromAsync (Node 22)"],
    [/\bPromise\.withResolvers\b/, "Promise.withResolvers (Node 22)"],
    [/import\.meta\.(dirname|filename)\b/, "import.meta.dirname/filename (Node 20.11)"],
    [/\bfs\.(glob|globSync)\b/, "fs.glob (Node 22)"],
    [/\.(isWellFormed|toWellFormed)\(/, "String well-formed methods (Node 20)"],
    [/\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, "Set methods (Node 22)"],
    [/process\.getBuiltinModule|process\.loadEnvFile|util\.styleText|\bstyleText\b/, "newer process/util APIs"],
    [/\bimport\s[^;]*\swith\s*\{/, "import attributes"],
    [/\bfs\.cpSync\b/, "fs.cpSync is experimental before Node 22"],
  ];
  for (const f of [...files("src", ".mjs"), ...files("bin", ".mjs")]) {
    const text = read(f);
    for (const [re, what] of newer) assert.doesNotMatch(text, re, `${f}: ${what}`);
  }
});

test("the licence, the conduct file, the changelog and the version agree", () => {
  assert.match(read("LICENSE"), /^MIT License/);
  assert.match(read("LICENSE"), /Copyright \(c\) 2026 Naresh Prabu/);
  assert.ok(exists("CODE_OF_CONDUCT.md"));
  assert.match(read("CHANGELOG.md"), new RegExp(`^## \\[${VERSION.replace(/\./g, "\\.")}\\] - 2026-10-28$`, "m"));
  assert.match(read("CHANGELOG.md"), new RegExp(`^\\[${VERSION.replace(/\./g, "\\.")}\\]: https://github\\.com/nrzz/claude-settings-doctor/releases/tag/v${VERSION.replace(/\./g, "\\.")}$`, "m"));
  for (const f of ["SECURITY.md", "SUPPORT.md", "ROADMAP.md", "CONTRIBUTING.md"]) assert.ok(exists(f), f);
  assert.match(read("SECURITY.md"), /security\/advisories\/new/);
  const roadmap = read("ROADMAP.md");
  assert.ok((roadmap.match(/^- /gm) || []).length >= 3 && (roadmap.match(/^- /gm) || []).length <= 5, "three to five next steps");
  assert.match(roadmap, /good first issue/);
});

test("the issue forms and the pull request template are there", () => {
  for (const f of ["bug_report.yml", "feature_request.yml", "config.yml"]) assert.ok(exists(`.github/ISSUE_TEMPLATE/${f}`), f);
  assert.match(read(".github/ISSUE_TEMPLATE/config.yml"), /blank_issues_enabled: false/);
  assert.match(read(".github/ISSUE_TEMPLATE/config.yml"), /nrzz\/claude-settings-doctor\/discussions/);
  assert.ok(exists(".github/PULL_REQUEST_TEMPLATE.md"));
  assert.match(read(".github/dependabot.yml"), /package-ecosystem: github-actions/);
});

test("the CI workflows: the suite on three systems and four Node versions, and the real-binary checks on two systems, with no action version pinned here", () => {
  const ci = read(".github/workflows/test.yml");
  assert.match(ci, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(ci, /node: \[20, 22, 24\]/);
  assert.match(ci, /node: 18/);
  assert.match(ci, /run: npm test/);
  assert.match(ci, /uses: actions\/checkout@/);
  assert.match(ci, /uses: actions\/setup-node@/);
  // a job that hangs ends in minutes: a watcher that a failed test left open once held a macOS job for 21 minutes
  assert.match(ci, /timeout-minutes: \d+/);
  const e2e = read(".github/workflows/e2e.yml");
  for (const part of ["name: e2e", "ubuntu-latest, macos-latest", "npm install -g @anthropic-ai/claude-code", "continue-on-error: true", "E2E_CLAUDE: claude", "test/e2e-claude.test.mjs", "schedule:", "workflow_dispatch"]) assert.ok(e2e.includes(part), part);
  assert.match(e2e, /timeout-minutes: \d+/);
  assert.ok(!e2e.includes("windows"));
});

const README_SECTIONS = ["## What you get", "## What it costs in tokens", "## Install", "## Use", "## How it works", "## What was verified, and how", "## Not verified", "## Files", "## Contributing", "## Part of the Claude Code toolkit", "## License"];
const TOOLKIT = [
  "- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself",
  "- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers",
  "- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD",
  "- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits",
  "- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes",
  "- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings",
  "- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it",
  "- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command",
  "- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay",
  "- [claude-chat-ferry](https://github.com/nrzz/claude-chat-ferry): continue a Cursor or Antigravity chat in Claude Code, or hand a session to them",
  "- [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history",
  "- [claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep",
  "- [claude-hook-bench](https://github.com/nrzz/claude-hook-bench): run every hook with the JSON Claude Code sends, and see what each one does",
  "- [claude-relocate](https://github.com/nrzz/claude-relocate): move Claude Code's config folder to another drive or the XDG folders, safely, with undo",
];

test("the README has the sections the house keeps, in order, and the Privacy heading the plugin manifest links to", () => {
  const readme = read("README.md");
  let at = -1;
  for (const h of README_SECTIONS) {
    const i = readme.indexOf(`\n${h}\n`);
    assert.ok(i > at, `${h} is there, after the one before it`);
    at = i;
  }
  assert.match(readme, /^# claude-settings-doctor\n/);
  assert.ok(readme.indexOf("\n### Privacy\n") > readme.indexOf("\n## How it works\n") && readme.indexOf("\n### Privacy\n") < readme.indexOf("\n## What was verified, and how\n"), "### Privacy sits under How it works");
  assert.ok(plugin.privacyPolicyUrl.endsWith("#privacy"));
});

test("the README names every command and every option the CLI has, and the install lines", () => {
  const readme = read("README.md");
  for (const cmd of ["show", "lint", "explain", "init", "build", "check", "absorb", "watch", "restore"]) assert.ok(readme.includes(`### ${cmd}`) || readme.includes(`### \`${cmd}\``), `a heading for ${cmd}`);
  for (const flag of ["--user", "--project", "--local", "--file", "--markdown", "--dry-run", "--force", "--jsonc", "--list", "--poll", "--json", "--no-color"]) assert.ok(readme.includes(`\`${flag}`), flag);
  for (const cmd of ["claude-settings-doctor show", "claude-settings-doctor lint", "claude-settings-doctor explain", "claude-settings-doctor init", "claude-settings-doctor build", "claude-settings-doctor check", "claude-settings-doctor absorb", "claude-settings-doctor watch", "claude-settings-doctor restore"]) assert.ok(readme.includes(cmd), cmd);
  assert.ok(readme.includes("npx -y github:nrzz/claude-settings-doctor lint --project ."));
  assert.ok(readme.includes("git clone https://github.com/nrzz/claude-settings-doctor"));
  assert.ok(readme.includes("/plugin marketplace add nrzz/claude-code-toolkit"));
  assert.ok(readme.includes("/plugin install settings-doctor@claude-code-toolkit"));
  assert.ok(readme.includes("/settings-doctor:check"));
  assert.ok(readme.includes("#17968") && readme.includes("#4475"), "the two issues it answers");
  assert.ok(!/\p{Extended_Pictographic}/u.test(readme), "no emoji");
  assert.ok(!/\b(simply|easily|blazing|seamless|powerful|amazing)\b/i.test(readme), "plain words");
});

test("the README says which schema it used, and the schema's record agrees", () => {
  const readme = read("README.md");
  const { meta } = loadSchema();
  assert.ok(readme.includes(meta.downloaded), `the schema download date ${meta.downloaded}`);
  assert.ok(readme.includes("Apache-2.0"));
  assert.ok(readme.includes(`${meta.properties} top-level keys`) || readme.includes(`${meta.properties} keys`), `the schema's ${meta.properties} keys`);
});

test("the toolkit list: the fourteen lines, the page line and the star line", () => {
  const readme = read("README.md");
  const section = readme.slice(readme.indexOf("\n## Part of the Claude Code toolkit\n"), readme.indexOf("\n## License\n"));
  const lines = section.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lines, TOOLKIT);
  assert.ok(section.includes("Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on."));
  assert.ok(section.includes("If one of them saves you tokens, a star on its repository helps other people find it, and following [@nrzz](https://github.com/nrzz) on GitHub shows you new tools and releases."));
});

test("the links in the README that point into the repository go to files that are there", () => {
  const readme = read("README.md");
  for (const m of readme.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) assert.ok(exists(m[1].split("#")[0]), `${m[1]} is linked and exists`);
});

test("no test asks the machine for its home folder: every test builds its own world in a temporary folder", () => {
  for (const f of files("test", ".mjs")) {
    if (f.endsWith("repo.test.mjs")) continue;
    assert.doesNotMatch(read(f), /os\.homedir\(\)/, `${f} reaches for the real home folder`);
  }
});

test("the process the tests run in has its home, config folder and managed folder pointed at a throwaway folder", () => {
  assert.notEqual(process.env.CLAUDE_CONFIG_DIR, "");
  assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(process.env.HOME), "the config folder is inside the throwaway home");
  assert.match(process.env.CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR, /no-managed-settings$/);
  assert.equal(process.env.USERPROFILE, process.env.HOME);
});

test("the usage block of the README is the help text of the CLI, and nothing is left to fill in", async () => {
  const readme = read("README.md");
  const help = (await run(["--help"], world("readme-help"))).out;
  const usage = help.slice(help.indexOf("Usage: claude-settings-doctor")).trimEnd();
  assert.ok(readme.includes(usage), "the README's usage block is out of date: paste the output of claude-settings-doctor --help from its Usage line");
  assert.ok(!readme.includes("@@"), "a placeholder is still in the README");
});

test("the numbers the README quotes are the numbers of the code: the table, the cap, the instruction, the description, the schema", async () => {
  const readme = read("README.md");
  const { ROWS } = await import("./lint-table.mjs");
  const fine = ROWS.filter((r) => r.expect.length === 0).length;
  assert.ok(readme.includes(`holds ${ROWS.length} settings: ${ROWS.length - fine} with something wrong in them and ${fine} that the binary takes as they are`), `the lint table has ${ROWS.length} rows, ${fine} of them fine`);
  assert.ok(readme.includes(`for every one of the ${ROWS.length},`));
  // the cap of the markdown report
  const w = world("readme-cap");
  w.user(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`unknownKey${i}`, i])));
  const md = (await run(["lint", "--markdown"], w)).out;
  assert.equal(md.split("\n").filter((l) => l.startsWith("- WARNING")).length, 12);
  assert.ok(readme.includes("at most 12 findings") || readme.includes("at most 12 of them"));
  // what the skill costs: its instruction and its description
  const skill = read("skills/check/SKILL.md");
  const body = skill.slice(/^---\n[\s\S]*?\n---\n/.exec(skill)[0].length);
  const instruction = body.split("\n").filter((l) => l && !l.startsWith("!`")).join("\n");
  assert.ok(readme.includes(`${instruction.length}-character instruction`), `the instruction is ${instruction.length} characters`);
  const desc = /^description: (.+)$/m.exec(skill)[1];
  assert.ok(readme.includes(`\`${desc}\`: ${desc.length} characters`), `the description is ${desc.length} characters`);
  // the schema
  assert.ok(readme.includes(`${loadSchema().meta.properties} top-level keys`));
});
