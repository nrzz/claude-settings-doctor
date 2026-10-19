# claude-settings-doctor

[![test](https://github.com/nrzz/claude-settings-doctor/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-settings-doctor/actions/workflows/test.yml) [![e2e](https://github.com/nrzz/claude-settings-doctor/actions/workflows/e2e.yml/badge.svg)](https://github.com/nrzz/claude-settings-doctor/actions/workflows/e2e.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

Claude Code's settings files take no comments: [#17968](https://github.com/anthropics/claude-code/issues/17968) asks for JSONC (127 reactions, open since January) and [#4475](https://github.com/anthropics/claude-code/issues/4475) for a `description` field (25 reactions, as read on 16 October 2026). A comment or a trailing comma gets no error in a `claude -p` run: Claude Code ignores the whole file and says nothing about it. `claude doctor` lists the file. A key it does not know is ignored without a word. A value of the wrong type costs the whole file in most keys, and `claude doctor` is where it is listed. The four settings files (managed, user, project and local), with flags and plugin defaults around them, merge into one object that no command in `claude --help` shows.

claude-settings-doctor gives your settings comments. You write `settings.jsonc`. `build` writes the `settings.json` that Claude Code reads. `absorb` takes what Claude Code wrote into `settings.json` (an "Always allow" rule, a `/config` change) back into the commented file. The tool shows the merged settings with the file each value came from, lints every file against the schema, and explains a key. Where a mistake costs something, the lint says what Claude Code does about it. It is a plain Node program that runs outside Claude, so it costs no tokens.

## What you get

- `show`: the settings Claude Code merges (managed, local, project, user). Every value comes with the file it came from and what a higher file shadows. A list is its items, each with a file. The files Claude Code ignores are listed with the reason.
- `lint` finds:
  - a comment or a trailing comma (Claude Code ignores the whole file);
  - keys the schema does not know, with the near name;
  - values of the wrong type or outside the allowed list, and deprecated keys;
  - `env` values that are not strings;
  - hook entries, groups and events of the wrong shape, and a hook matcher that is not a regular expression;
  - a key written twice, and `managedMcpServers` outside managed settings, where Claude Code ignores it.

  Each finding has the file and the key path, and the line and column when there is one. For a mistake that costs something it says what Claude Code does about it.
- `explain <key>`: what the schema says about a key (its type, default, allowed values and description), which files set it now, and how they combine: the highest file wins a value, lists are joined, objects merge key by key.
- `init`, `build`, `check`, `absorb`, `watch`: the commented source. `init` writes `settings.jsonc` next to a settings file, with a comment above each key the schema describes. `build` writes `settings.json` from it, saving the old file first, and refuses when `settings.json` changed since the last build. `check` exits 1 when `settings.json` holds other settings than `build` would write, for CI and pre-commit. `absorb` takes Claude Code's own edits back into `settings.jsonc`, comments kept. `watch` builds on every save.
- `restore`: puts the newest backup of a settings file back, and can itself be undone.
- `/settings-doctor:check`, a plugin skill that hands Claude the short form of the `lint` report (`lint --markdown`).

## What it costs in tokens

| Part | Tokens | |
| --- | --- | --- |
| The tool: every command, `--json`, `--markdown`, `watch`, `check` in CI | 0 | It reads and writes settings files. It never calls Claude, opens no network connection and starts no process |
| The skill in the model's request | 0 | `/settings-doctor:check` is user-only (`disable-model-invocation: true`) and its description is `Check settings files.`: 21 characters, about 5 tokens by characters / 4. With the plugin loaded, the request for a plain prompt had the same size as without it. It also had the same tool list and no occurrence of `settings-doctor`. The sizes were 68,582 characters on Claude Code 2.1.295, 69,112 on 2.1.299 and 64,376 on 2.1.301 on Linux (checked against a fake API, see below). `claude plugin details` still projects about 11 tokens "always-on" for the skill. The capture does not bear that out |
| `/settings-doctor:check` | about 340 tokens once; about 1,000 at the cap | The model receives the lint report and a 251-character instruction that asks for a reply of at most 10 lines. For a project with 3 findings on Windows that was 1,254 characters in the skill block and 109 in the command block: 1,363 in all, about 341 tokens by characters / 4. The skill block holds the project's path, so it was 1,225 characters on Linux and 1,330 on macOS in CI. The report is capped at 12 findings and 300 characters a line. A report at the cap (a user file and a project file with 40 long unknown keys each, and a local file with a comment) was 4,091 characters in 20 lines, about 1,023 tokens. These are characters divided by 4, an estimate, not a count by Claude's tokenizer. The same findings in a terminal cost nothing: `claude-settings-doctor lint` |

## Install

**From a terminal**, with Node 18 or newer. There is nothing to install and no dependency:

```bash
npx -y github:nrzz/claude-settings-doctor lint --project .
```

```bash
npx -y github:nrzz/claude-settings-doctor show --project .
```

Or from a clone:

```bash
git clone https://github.com/nrzz/claude-settings-doctor
node claude-settings-doctor/bin/claude-settings-doctor.mjs lint --project .
```

**As a Claude Code plugin**, in Claude Code:

```text
/plugin marketplace add nrzz/claude-code-toolkit
/plugin install settings-doctor@claude-code-toolkit
```

Then type `/settings-doctor:check`. It runs `lint --markdown` for the current project and asks Claude to answer in at most 10 lines: each problem with its settings file and line, and the fix. It also asks Claude to edit nothing until you agree. To try the plugin from a clone before it is in the marketplace: `claude --plugin-dir ./claude-settings-doctor`.

## Use

The examples are real runs in a throwaway folder on Windows 11; the paths are shortened to `/home/me/shop`, and the managed file is shown at its Linux place. The folder holds a user file, a project file and a local file with something wrong in each.

```text
Usage: claude-settings-doctor <command> [options]

Read (they change nothing):
  show     [--project <dir>] [--only <key>]
           the settings Claude Code merges: every value, the file it came from, which file wins,
           and the values a higher file shadows
  lint     [--project <dir>] [--file <path>] [--markdown]
           mistakes in the settings files that apply: a comment or a trailing comma (Claude Code
           ignores the whole file), keys the schema does not know, wrong types, bad values,
           deprecated keys, env values that are not strings, hook entries of the wrong shape,
           repeated keys, managedMcpServers outside managed settings. --file checks one file (a
           .jsonc too). Exit 1 on an error or a warning. --markdown is the short report the
           /settings-doctor:check skill hands to Claude (at most 12 findings); it always exits
           0, because Claude Code drops a skill whose command fails
  explain  <key> [--project <dir>]
           what the schema says about a key (permissions.defaultMode, hooks.PreToolUse): its type,
           default and description, and which file sets it now

The commented source (each takes --user, --project <dir> or --local to name the settings file):
  init     [--force] [--dry-run]
           write settings.jsonc next to settings.json, with a comment above each key the schema
           describes
  build    [--force] [--dry-run]
           write settings.json from settings.jsonc: comments and trailing commas gone, keys in
           order, two-space indentation; the old file is saved first; refuses when settings.json
           changed since the last build (--force overrides)
  check
           exit 1 when settings.json holds other settings than build would write from
           settings.jsonc, or does not exist (for CI and pre-commit); a different layout alone is
           fine. Writes nothing
  absorb   [--dry-run]
           take what Claude Code changed in settings.json (an "Always allow" rule, a /config
           change) into settings.jsonc, comments kept; the old settings.jsonc is saved first
  watch    [--poll <ms>] [--dry-run]
           build now, and again on every save of settings.jsonc; --poll looks at the file every
           <ms> milliseconds (50 or more), for a place where folder events do not arrive
  restore  [--jsonc] [--list] [--dry-run]
           put the newest backup back (of settings.jsonc with --jsonc); --list names the backups

Files: --user is <config folder>/settings.json (CLAUDE_CONFIG_DIR, else ~/.claude);
--project <dir> is <dir>/.claude/settings.json; --local is <dir>/.claude/settings.local.json
(<dir> is the folder --project names, else the folder you are in; on Linux and macOS in a git
repository --local is at the root of the repository). The commented source sits next to
each, with the extension .jsonc. Claude Code reads settings.json only.

Options for every command:
  --json         one JSON document on stdout
  --no-color     no colour on a terminal (NO_COLOR does the same)
  -h, --help     this text
  -v, --version  the version

Exit codes: 0 ok; 1 findings, a difference or a refusal; 2 a usage error or an unexpected error.
Environment: CLAUDE_CONFIG_DIR (Claude's config folder), NO_COLOR, and
CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR (the folder to read managed-settings.json from, instead of the
system folder; the tests use it).
It reads settings files, writes only with init, build, absorb, watch and restore (a settings
file they replace is saved next to itself first), and never uses the network.
```

Every command takes `--json` (one JSON document on stdout, see the end of this section) and `--no-color` (or set `NO_COLOR`); colour is used only on a terminal. The exit codes are 0 for ok, 1 for findings, a difference or a refusal, and 2 for a usage error. The options a command does not take are refused by name.

### `show`

`show [--project <dir>] [--only <key>]` reads the managed, user, project and local files that apply to the folder (the current one, or `--project`). It prints them from the highest precedence down with their state: not found, read, empty, unreadable, or ignored by Claude Code and why. Then it prints every value of the merge with the file it came from. A value a higher file replaced is listed under it as shadowed. A list is its items, each with its file (a rule in two files is one item, with both named). A key the schema does not list is tagged, at the first two levels of its path (`lint` looks at every level). `--only <key>` prints only the entries at or below a key (such as `permissions` or `env`). `show` ends with what it does not read.

```text
claude-settings-doctor show
```

```text
claude-settings-doctor 1.0.0  the settings Claude Code merges
project   /home/me/shop
config    /home/me/.claude  (from CLAUDE_CONFIG_DIR)
schema    SchemaStore's claude-code-settings.json, downloaded 2026-10-16

Settings files, highest precedence first
  managed  /etc/claude-code/managed-settings.json  not found
  local    .claude/settings.local.json             ignored by Claude Code: it has a comment
  project  .claude/settings.json                   read, 3 keys; 1 part dropped by Claude Code
  user     ~/.claude/settings.json                 read, 5 keys; 1 env value turned into strings

Merged settings (7 values from 2 files; a higher file wins a key, objects merge key by key, lists are joined)
  model                        "sonnet"                                  project
      shadowed: "opus" in user settings (~/.claude/settings.json)
  includeCoAuthoredBy          false                                     user
  permissions.allow            3 items  (user 2, project 1)
      "Bash(git status)"                                                user
      "Bash(npm test)"                                                  user (also project)
      "Bash(npm run build)"                                             project
  permissions.deny             1 item  (project 1)
      "Read(./.env)"                                                    project
  env.BASH_DEFAULT_TIMEOUT_MS  "120000"                                  user
  cleanupPeriodDay             14                                        user  (not in the schema)
  hooks.SessionStart           1 item  (project 1)
      {"hooks":[]}                                                      project

1 key shadowed. Findings: 2 errors, 3 warnings (run lint).

Not read by this tool:
  - server-managed settings, macOS profiles and the Windows registry (only managed-settings.json and managed-settings.d are read)
  - the --settings, --setting-sources and --add-dir flags, and what Claude Code writes to its own state during a session
  - environment variables Claude Code reads itself (ANTHROPIC_MODEL, CLAUDE_CODE_*), and ~/.claude.json
  - plugin settings: a plugin supplies its own agent and statusLine defaults, which come below all of these
```

The local file has a comment, so Claude Code ignores all of it, and `show` leaves its `Bash(ls)` rule out. The project's hook has a timeout written as a string, so Claude Code drops that entry and the group is left with no hooks. The user's `BASH_DEFAULT_TIMEOUT_MS` is shown as the string Claude Code makes of the number. Flags and plugins are not read, and `show` says so every time.

### `lint`

`lint [--project <dir>] [--file <path>] [--markdown]` checks every file that applies. `--file` checks one file; a `.jsonc` may have comments and trailing commas, and is still held to the schema. The exit code is 1 when there is an error or a warning, 0 otherwise (a note does not count). A finding has one of three severities:

- an error: Claude Code drops something the file says (the whole file, a field, an entry, a group or an event);
- a warning: the file still applies, but something in it is probably not what you meant, and Claude Code may ignore just that key (an unknown key, a key written twice, a matcher that never matches);
- a note: worth knowing, nothing is lost.

```text
claude-settings-doctor lint
```

```text
claude-settings-doctor 1.0.0  lint
project   /home/me/shop
config    /home/me/.claude  (from CLAUDE_CONFIG_DIR)
schema    SchemaStore's claude-code-settings.json, downloaded 2026-10-16

.claude/settings.local.json  local settings
  error   invalid-json      line 2
      The file has a comment (//), which JSON does not have (line 2). Claude Code ignores the
      whole file: none of its settings apply (claude doctor says "Invalid or malformed JSON").
      fix: Keep the notes in a settings.jsonc and write settings.json with claude-settings-doctor
      build, or delete the comments.

.claude/settings.json  project settings
  error   hook-shape        line 9  hooks.SessionStart[0].hooks[0].timeout
      timeout should be a number, found a string. Claude Code ignores this entry: it never runs
      (claude doctor: "entry ignored").

~/.claude/settings.json  user settings
  warning deprecated        line 3  includeCoAuthoredBy
      "includeCoAuthoredBy" is deprecated: Use 'attribution' instead.
  warning env-not-string    line 8  env.BASH_DEFAULT_TIMEOUT_MS
      "BASH_DEFAULT_TIMEOUT_MS" is a number; Claude Code turns it into the string "120000". Write
      it as a string.
  warning unknown-key       line 10  cleanupPeriodDay
      "cleanupPeriodDay" is not in the schema (the schema is SchemaStore's, downloaded
      2026-10-16). Claude Code ignores keys it does not know, without a word. Did you mean
      "cleanupPeriodDays"?

2 errors, 3 warnings, 0 notes in 3 files
```

The ids are `invalid-json`, `not-an-object`, `empty-file`, `duplicate-key`, `unknown-key`, `wrong-type`, `bad-value`, `deprecated`, `duplicate-item`, `env-not-string`, `env-name`, `managed-only`, `hook-event`, `hook-shape`, `hook-matcher`, `jsonc-out-of-date`, `unreadable` and `not-checked`. Three need a word. `managed-only` is `managedMcpServers` in a file that is not a managed one: Claude Code ignores it there, whatever its value. `jsonc-out-of-date` is a `settings.jsonc` that does not match its `settings.json`: it is behind it, it cannot be built, or `settings.json` is not there yet (a difference in layout alone is a note). `not-checked` is a place where the schema uses a keyword the checker does not judge, said once per file. Where a mistake costs something, what Claude Code does about it is what the real binary did when it was put to it; "What was verified, and how" says how. A few kinds say what to do and not what Claude Code does: `deprecated`, `duplicate-item`, `empty-file`, `jsonc-out-of-date` and `not-checked`.

With `--markdown` the report is the short form the skill hands to Claude. It holds the errors and warnings only, at most 12 of them, each line at most 300 characters (the message is cut before the fix is). When there are more, a last line says ``- ... and N more (run `claude-settings-doctor lint`)``. It exits 0 whatever it finds. The reason: a skill whose command exits 1 never reaches the model. A copy of the skill that ran `lint` without `--markdown` on a project with a finding never reached the model on Claude Code 2.1.295, 2.1.299 and (in CI) 2.1.301, and the same skill with `--markdown` did. The same project:

```text
claude-settings-doctor lint --markdown
```

```text
## settings-doctor lint: /home/me/shop
3 settings files read, 2 errors, 3 warnings, 0 notes. Schema: SchemaStore, downloaded 2026-10-16.
- ERROR `invalid-json` .claude/settings.local.json:2: The file has a comment (//), which JSON does not have (line 2). Claude Code ignores the whole file: none of its settings... Fix: Keep the notes in a settings.jsonc and write settings.json with claude-settings-doctor build, or delete the comments.
- ERROR `hook-shape` .claude/settings.json:9 `hooks.SessionStart[0].hooks[0].timeout`: timeout should be a number, found a string. Claude Code ignores this entry: it never runs.
- WARNING `deprecated` ~/.claude/settings.json:3 `includeCoAuthoredBy`: "includeCoAuthoredBy" is deprecated: Use 'attribution' instead.
- WARNING `env-not-string` ~/.claude/settings.json:8 `env.BASH_DEFAULT_TIMEOUT_MS`: "BASH_DEFAULT_TIMEOUT_MS" is a number; Claude Code turns it into the string "120000". Write it as a string.
- WARNING `unknown-key` ~/.claude/settings.json:10 `cleanupPeriodDay`: "cleanupPeriodDay" is not in the schema (the schema is SchemaStore's, downloaded 2026-10-16). Claude Code ignores keys it does not know, without a word. Did you mean "cleanupPeriodDays"?
```

### `explain`

`explain <key> [--project <dir>]` takes a key as `permissions.defaultMode`, `hooks.PreToolUse[0].matcher` or `env.MY_VARIABLE`. It prints the schema's type, default, allowed values, examples and description, and the keys inside an object. Then it lists the files that set the key now: which wins, which are shadowed, and which Claude Code ignores and why. For a list or an object it says that all the files contribute. A key the schema does not know exits 1 with the nearest names. When the first part of a path is the typo, it says so.

```text
claude-settings-doctor explain model
```

```text
model   string

Override the default model used by Claude Code. For finer control, use environment variables:
ANTHROPIC_MODEL (runtime override), ANTHROPIC_DEFAULT_OPUS_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL,
ANTHROPIC_DEFAULT_HAIKU_MODEL (per-class pinning), CLAUDE_CODE_SUBAGENT_MODEL (subagent model). See
https://code.claude.com/docs/en/model-config

Set now in:
  project  .claude/settings.json        "sonnet"  <- wins
  user     ~/.claude/settings.json      "opus"  (shadowed)

From SchemaStore's schema, downloaded 2026-10-16; Claude Code can know more or less.
```

```text
claude-settings-doctor explain permissions.allow
```

```text
permissions.allow   array of strings

List of permission rules for allowed operations

Set now in:
  local    .claude/settings.local.json  ["Bash(ls)"]  (Claude Code ignores this file: it has a comment)
  project  .claude/settings.json        ["Bash(npm test)","Bash(npm run build)"]  (joined with the others)
  user     ~/.claude/settings.json      ["Bash(git status)","Bash(npm test)"]  (joined with the others)
Claude Code joins the items of all the files: 3 in all.

From SchemaStore's schema, downloaded 2026-10-16; Claude Code can know more or less.
```

```text
claude-settings-doctor explain cleanupPeriodDay
```

```text
cleanupPeriodDay is not in the schema (SchemaStore, downloaded 2026-10-16).
Did you mean "cleanupPeriodDays"?
```

### `init`

`init (--user | --project <dir> | --local) [--force] [--dry-run]` writes `settings.jsonc` next to the settings file (`settings.local.jsonc` next to `settings.local.json`). The values and the order of the keys are those of the settings file. The layout is the one `build` writes: two spaces, and one item of a list on each line. Above each key the schema describes there is a comment with its description, its type, its default and the values it allows. A key the schema does not list gets a comment that says so, with the near name. Inside a list only the first item is annotated, and the names under `env` get no comment. `init` refuses when the `.jsonc` is already there (`--force` replaces it after a backup of the old one) and when the settings file is not valid JSON (Claude Code ignores it too). The settings file is not touched.

```text
claude-settings-doctor init --project .
```

```text
Wrote /home/me/shop/.claude/settings.jsonc: 5 keys annotated.
Claude Code reads settings.json only. Edit settings.jsonc, then run: claude-settings-doctor build --project .
```

The start of the file it wrote:

```jsonc
// settings.jsonc is the commented source of settings.json. Claude Code reads settings.json only,
// and a comment in that file makes Claude Code ignore all of it.
// Edit this file, then run: claude-settings-doctor build --project .
// The comments are SchemaStore's descriptions (Apache-2.0), downloaded 2026-10-16; Claude Code can
// know more keys than the schema does, or fewer.
{
  // Override the default model used by Claude Code. For finer control, use environment variables:
  // ANTHROPIC_MODEL (runtime override), ANTHROPIC_DEFAULT_OPUS_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL,
  // ANTHROPIC_DEFAULT_HAIKU_MODEL (per-class pinning), CLAUDE_CODE_SUBAGENT_MODEL (subagent model).
  // See https://code.claude.com/docs/en/model-config
  // type: string
  "model": "sonnet",

  // Tool usage permissions configuration. See https://code.claude.com/docs/en/permissions and
  // https://code.claude.com/docs/en/settings#permission-settings See
  // https://code.claude.com/docs/en/tools-reference for full list of tools available to Claude.
  // type: object
  "permissions": {
    // List of permission rules for allowed operations
    // type: array of strings
    "allow": [
      "Bash(npm test)"
    ],
    ...
```

### `build`

`build (--user | --project <dir> | --local) [--force] [--dry-run]` writes the settings file from its `.jsonc`: the comments and trailing commas gone, the keys in the order they were written, two-space indentation, a final newline, and numbers and strings exactly as written. The old file is saved next to it first. `build` refuses, writing nothing, when:

- the `.jsonc` is missing, is not JSON with comments, or writes a key twice (Claude Code keeps only the last, so `build` will not choose for you);
- the settings file is not valid JSON, so Claude Code cannot read it either (`--force` replaces it after a backup);
- the settings file changed since the last build, absorb or init. A rule Claude Code added would be thrown away, so the refusal lists what changed and says to run `absorb`, or to use `--force`.

A settings file that only looks different (another layout, another order of keys or of rules) does not stop it.

```text
claude-settings-doctor build --project . --dry-run
```

```text
(dry run) Would write /home/me/shop/.claude/settings.json (1 change):
(dry run)   ~ model: "sonnet" -> "opus"
Nothing was written (--dry-run).
```

```text
claude-settings-doctor build --project .
```

```text
Wrote /home/me/shop/.claude/settings.json (1 change).
  ~ model: "sonnet" -> "opus"
The old file is saved as /home/me/shop/.claude/settings.json.bak-settings-doctor-20261016-095721. Undo with: claude-settings-doctor restore --project .
```

I had added a comment above `env` and one after the model in `settings.jsonc`; the `settings.json` it wrote has neither:

```json
{
  "model": "opus",
  "permissions": {
    "allow": [
      "Bash(npm test)"
    ],
    "deny": [
      "Read(./.env)"
    ]
  },
  "env": {
    "NODE_ENV": "development"
  }
}
```

### `check`

`check (--user | --project <dir> | --local)` exits 0 when `settings.json` holds the settings that `build` would write from `settings.jsonc`, and 1 when it does not, when it is missing, or when Claude Code could not read it (it has a comment). It compares the settings, not the bytes: a different indentation, line endings after a checkout, a missing final newline, another order of keys or of rules are not drift, because Claude Code reads the same settings (it says so, and exits 0). It writes nothing. It is made for CI and for a pre-commit hook.

```text
claude-settings-doctor check --project .
```

```text
settings.json is what build writes from settings.jsonc.
```

After Claude Code wrote an "Always allow" rule and a `/config` change into `settings.json`:

```text
settings.json differs from what build writes from settings.jsonc. Build would change:
  - theme (was "dark")
  - permissions.allow item "Bash(git status)"
Run claude-settings-doctor build --project . to write it, or claude-settings-doctor absorb --project . to take the changes in settings.json into settings.jsonc.
```

### `absorb`

`absorb (--user | --project <dir> | --local) [--dry-run]` takes what changed in `settings.json` since the last build, absorb or init into `settings.jsonc`, by editing its text. The comments, blank lines, indentation, line endings and the order of keys stay. What is added goes after the last key or item, in the layout of the others. A key or item taken out goes with the comments right above it and the one after it on its line. A value you changed yourself in `settings.jsonc` is yours: it is reported as a conflict (exit 1) and not overwritten, and the record of the last build is not moved until you decide. A change inside an item of a list (a hook group whose matcher changed, a hook added to a group) is made in the item, where it is, so its comments stay and it does not move to the end. With no record of the last build only additions are taken, and the rest is listed as left alone. The old `settings.jsonc` is saved first.

While `settings.json` holds changes that `settings.jsonc` has not, `build` refuses to write over them:

```text
claude-settings-doctor build --project .
```

```text
settings.json has changed since it was last built from settings.jsonc (Claude Code, or you, edited it):
  + permissions.allow item "Bash(git status)"
  + theme = "dark"
Refused: building now would drop the changes made in settings.json
Run claude-settings-doctor absorb --project . to keep those changes in settings.jsonc, or claude-settings-doctor build --project . --force to overwrite them (a backup is made either way).
```

```text
claude-settings-doctor absorb --project . --dry-run
```

```text
(dry run) Would take 2 changes from settings.json into settings.jsonc:
(dry run)   + permissions.allow item "Bash(git status)"
(dry run)   + theme = "dark"
Nothing was written (--dry-run).
```

```text
claude-settings-doctor absorb --project .
```

```text
Took 2 changes from settings.json into settings.jsonc:
  + permissions.allow item "Bash(git status)"
  + theme = "dark"
The old settings.jsonc is saved as /home/me/shop/.claude/settings.jsonc.bak-settings-doctor-20261016-095722. Undo with: claude-settings-doctor restore --project . --jsonc
```

`check` then exits 0 and `build` has nothing to write. The "Always allow" and `/config` edits in these examples were made by a script that writes `settings.json` the way Claude Code does (two spaces); I did not drive the interactive interface.

### `watch`

`watch (--user | --project <dir> | --local) [--poll <ms>] [--dry-run]` builds once and then again every time `settings.jsonc` is saved, until you press Ctrl+C. It watches the folder, not the file, so an editor that saves by writing a new file and renaming it over the old one is seen, and saves that come close together are one build. A build that is refused (a typo in `settings.jsonc`, a `settings.json` that changed since the last build) is reported and the watching goes on, with `settings.json` as it was. `--poll <ms>` (50 or more) looks at the file every so many milliseconds instead, for a place where folder events do not arrive. It exits 1 if the first build was refused or there is no folder to watch, and 0 otherwise.

```text
claude-settings-doctor watch --project .
```

In this run I changed the model and added a comment after it, then broke the file with a typo, then fixed the typo by writing `production` where it was:

```text
Watching the source of the settings: waiting for saves. Ctrl+C stops.
[09:57:22] built at start: settings.json is already what build writes from settings.jsonc.
[09:57:24] saved: Wrote /home/me/shop/.claude/settings.json (1 change).
[09:57:26] saved: refused: settings.jsonc cannot be built, line 20: expected "," or "}" here
[09:57:29] saved: Wrote /home/me/shop/.claude/settings.json (1 change).
```

With `--json` each line is one JSON document with an `event` (`start` or `saved`) and the fields of a `build` result.

### `restore`

`restore (--user | --project <dir> | --local) [--jsonc] [--list] [--dry-run]` puts the newest backup of `settings.json` (of `settings.jsonc` with `--jsonc`) back. The file as it was is saved first, so running `restore` again switches back. `--list` names the backups, oldest first. After a restore of `settings.json` it says what the commented file needs: `absorb` to carry the restored settings into it, because `build` refuses until then (unless the restored file matches the last build).

```text
claude-settings-doctor restore --project .
```

```text
Restored /home/me/shop/.claude/settings.json from /home/me/shop/.claude/settings.json.bak-settings-doctor-20261016-095721.
The file as it was is saved as /home/me/shop/.claude/settings.json.bak-settings-doctor-20261016-095722; run claude-settings-doctor restore --project . again to switch back.
settings.jsonc was not changed. Run claude-settings-doctor absorb --project . to carry the restored settings into it. claude-settings-doctor build --project . refuses until then, because settings.json differs from the last build; claude-settings-doctor build --project . --force would write settings.jsonc over the restore.
```

### The JSON documents

Every command takes `--json` and then prints one JSON document and nothing else, also for a usage error (`{ "ok": false, "error": "..." }`, exit 2). `watch` prints one document for each build, on its own line. Paths in a document are the paths of the system it ran on. The shapes below name the fields that are always there and mark the ones that are not with `?`.

```text
show     { project, configDir, configSource, schema: { downloaded, source },
           files: [ { scope, label, display, path, rank, exists, state, detail, topLevelKeys, findings } ],
           entries: [ { path, keyPath, value, source, shadowed: [ { source, value } ], items?, inSchema } ],
           tree, counts: { entries, shadowed, findings }, notRead, only? }
lint     { project, configDir, configSource, schema,
           findings: [ { id, severity, effect, scope, file, display, line, column, path, keyPath, message, fix?, suggestions?, notChecked? } ],
           files: [ { scope, label, path, display, rank, exists, findings, ignored, notChecked? } ],
           counts: { error, warning, note } }
         (with --file: { project, file, error?, findings, counts, schema,
           files: [ { scope, label, path, display, exists, findings, effective } ] })
explain  { key, path, keyPath, schema, found, type, description, summary, default?, hasDefault, enum, examples, deprecated,
           children, moreChildren, setBy: [ { scope, label, display, path, rank, value, ignored } ], winner, combine,
           merged, mergedCount }
         (a key the schema lacks: key, path, keyPath, schema, found false, unknownAt, unknown, suggestions, listed)
init, build, check, absorb, restore, watch
         { action, ok, refused, dryRun, scope, file, source, lines, notes, ...what the action did }
         (init: backup, annotated, unknown, text; build: changed, backup, changes, problems?; check: differs, layoutOnly, changes, problems?;
         absorb: backup, applied, skipped, conflicts, unabsorbed, pending, baseline;
         restore: restored, from, savedCurrent, backups)
```

- `effect` says what Claude Code does about a finding:
  - `file`: the whole file is ignored;
  - `field`, `event`, `group` or `entry`: that part is dropped;
  - `key`: the key is ignored;
  - `coerced`: a value is turned into a string;
  - `none`: the finding is not about something Claude Code drops.
- `source` is the file a value came from: `{ scope, label, display, path, rank }`. `scope` is `managed`, `local`, `project` or `user`; a higher `rank` wins.
- `combine` in `explain` is `replace`, `join` (lists) or `merge` (objects).

## How it works

It reads, on your machine only:

- the settings files that apply, in the order Claude Code gives them (highest first):
  - `managed-settings.json` and `managed-settings.d/*.json` in the system folder: `C:\Program Files\ClaudeCode` on Windows, `/Library/Application Support/ClaudeCode` on macOS, `/etc/claude-code` on Linux;
  - `settings.local.json`, described next;
  - `<project>/.claude/settings.json`;
  - `<config folder>/settings.json`, where the config folder is `$CLAUDE_CONFIG_DIR` or `~/.claude`.
- the local file, which is `<project>/.claude/settings.local.json`. On Linux and macOS in a git repository Claude Code also reads the one at the repository root: Claude Code 2.1.301 in CI read the local files of both `repo/.claude` and `repo/sub/.claude` for a session started in `repo/sub`. On Windows (2.1.295 and 2.1.299) it read only the one of the folder it started in. The project file is the folder's own everywhere. The tool leaves out the root file when the root is your home folder or belongs to another user. That rule comes from claude-permission-doctor's loader, and it was not put to the binary here.
- the `.jsonc` next to each: `settings.json` has `settings.jsonc`, `settings.local.json` has `settings.local.jsonc`. Claude Code does not read them: a model written only in a `settings.jsonc` in the user, the project or the local place changed nothing in the binary.
- its own copy of the schema in `src/schema/`: SchemaStore's `claude-code-settings.json`, 142 top-level keys, downloaded 2026-10-16, under the Apache-2.0 licence (the text is next to it). The schema is community-maintained and can lag a Claude Code release, so every report says which download it used, and a key that is new may show as unknown. `scripts/update-schema.mjs` downloads a newer one; it is run by hand and is not part of the package.

How the files combine, as `show` and `explain` apply it: the files are merged from the lowest precedence up (user, project, local, then managed). Objects merge key by key, the higher file winning each key. Lists are joined, and an item that is already there is not added twice. Any other value is replaced by the higher file, also when it is of another type. The binary agreed on the first two rules and on the joining of lists, and it ran a hook that several files hold once. The other rules are the documentation's, and "Not verified" says so. A file Claude Code ignores is left out of the merge. What Claude Code drops from a file it keeps (a hook entry, a group, an event, a field) is left out too.

It writes only with `init`, `build`, `absorb`, `watch` and `restore`, and only the file you named with `--user`, `--project` or `--local` (or its `.jsonc`), the backups of it, and a record of the last build:

- **A backup first**, next to the file: `settings.json.bak-settings-doctor-<timestamp>` (local time, `-1`, `-2` when the name is taken). `restore` puts the newest back and can itself be undone. The backups are the file byte for byte.
- **A temporary file and a rename**, so nobody sees half a file. The mode of the file is kept. A symlink to the file is followed, so the link stays a link. When the rename cannot be done (another volume, a mount point) the text is written over the file in place.
- **A record of the last build**, one small file for each settings file, in `<config folder>/settings-doctor/`: the text of `settings.json` as of the last `build`, `absorb` or `init`. It is how `absorb` tells what Claude Code changed from what you did, and how `build` knows that `settings.json` changed. Without it `build` still works (after a backup) and `absorb` takes additions only.
- **Nothing else**: never managed settings, never `~/.claude.json`, never a transcript. A settings file that is not valid JSON is left alone: `init`, `absorb` and `build` refuse it (`build --force` replaces it after a backup). `build` also refuses a valid one that changed since the last build.
- **`--dry-run`** on every command that writes, and `check` writes nothing.

### Privacy

It reads the settings files and the `.jsonc` files next to them, on your machine. To find the local settings file on Linux and macOS it looks for `.git` in the folders above the project, and reads a worktree's `.git` file. To find backups and managed drop-in files it lists folders. It reads its own record of the last build. It writes only what is described above, on the commands that write, and saves a settings file next to itself before it replaces it. It never uses the network, starts no process, has no telemetry, no account and no cache outside `<config folder>/settings-doctor/`, and sends nothing anywhere. A test fails if any file under `src/` or `bin/` imports anything but `node:crypto`, `node:fs`, `node:os` or `node:path`, opens a socket or starts a process. The plugin's skill runs the same program and puts its report in front of Claude when you invoke it. That report holds file paths, line numbers, key names and messages. A message can quote the value it is about (a number in `env`, a value outside the allowed list, a permission rule). The report never contains a whole file.

## What was verified, and how

Checked on 2026-10-16 on Windows 11 with Node 24.19.0, git 2.55.0 and Claude Code 2.1.295 and 2.1.299 (every real-binary check passed on both). CI runs the unit tests on Linux, macOS and Windows with Node 20, 22 and 24 and on Linux with Node 18. It runs the real-binary checks on Linux and macOS against the npm release of Claude Code (2.1.301). All 12 jobs (10 of the unit tests, 2 of the real-binary checks) passed on the first green run, on 2026-10-16, and again on the release commit. The badges at the top show the latest runs.

- **349 automated tests** (`npm test`, Node's own runner, no dependencies, about 5 seconds). `node --test` also reports each of the five helper files under `test/` as a passing test, on every Node version CI runs (18 to 24); those are not counted here. Without a Claude Code binary 322 pass on Windows and 323 on Linux and macOS (the test of file modes is skipped on Windows). 26 are the real-binary checks below and run only when `E2E_CLAUDE` names one. The tests cover:
  - the JSONC reader: 500 random documents in four layouts read the way `JSON.parse` reads them, and 5,000 damaged ones accepted or refused as `JSON.parse` does;
  - the editing of text: 1,500 random documents for insert and for remove and 1,000 for replace, with every comment outside the changed element still there, and CRLF, tabs and spaces kept;
  - `build`: 1,000 random documents, and the output built again is the same;
  - `absorb`: random changes of `settings.json` taken into random commented files, with and without removals, with no record of the last build, and into lists of hook groups. The same settings come out, and every comment stays when nothing is taken out;
  - the comparison of two settings, and the writing code (backups, atomic writes, symlinks, the fallback when the rename fails, restore, the record of the last build);
  - `init`, `build`, `check`, `absorb` and `restore` through the command line in throwaway worlds, with the refusals and the files left untouched, and `watch`;
  - the loader and the merge (precedence, drop-in folders, git roots and worktrees, files of the wrong shape), the schema checker, the lint table, `explain`, the reports and their size caps, and the command line (every usage error and exit code);
  - the package files, the workflows and the README: its sections, commands, flags and usage block, and the numbers it quotes from the code.
- **26 checks against the real binary** (`test/e2e-claude.test.mjs`, run when `E2E_CLAUDE` names a Claude Code binary). Each starts a fake Messages API on 127.0.0.1, so no model is reached and no token is spent. Each has its own throwaway `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR` and a project folder that Claude Code already trusts. All 26 passed on 2.1.295 and on 2.1.299 on Windows. In CI on Linux and macOS with 2.1.301, 24 ran (two are for the Windows PowerShell tool) and passed. The findings below were the same everywhere unless a bullet says otherwise:
  - **A comment or a trailing comma.** 27 settings files: 9 kinds, each in the user, the project and the local file. Six kinds had a mistake: a `//` comment on its own line, a `//` comment after a value, a `/* */` comment, a comment on the first line, a trailing comma in an object, and one in an array. Three did not: strict JSON, CRLF line endings and a byte-order mark. In each of the 18 with a mistake, Claude Code ignored the whole file: a `model` in it did not arrive in the request and a `SessionStart` hook in it did not run. In each of the 9 without, both did. `lint` said the same for all 27. A `claude -p` run said nothing about the ignored file: what it wrote to stderr, and its reply, have none of the words settings, invalid, malformed, ignored, parse or json. A `settings.jsonc` that `build` wrote into a `settings.json` was read. A `settings.jsonc` alone, in the user, the project or the local place, changed nothing.
  - **Which file wins.** `model` and `env` in the user, project and local files, in five combinations (user alone, project over user, local over project, local over user, all three). The higher file won the model and each key of `env`, the keys of every file arrived (objects merge key by key), and the `SessionStart` hooks of every file ran (lists are joined). `show --json` named the same model, the same `env` and the same hooks in all five.
  - **A hook that several files hold.** The same hook in the user, project and local files ran once, not three times, and `show` lists it once with the three files. Other lists, such as a permission rule in two files, were not put to the binary.
  - **The lint table.** `test/lint-table.mjs` holds 97 settings: 86 with something wrong in them and 11 that the binary takes as they are. `claude doctor` listed, for every one of the 97, the paths the table says (and none for the ones that are only unknown keys or deprecated). In 63 of the rows the lint's message quotes `claude doctor`, with 11 distinct phrases, and `claude doctor` printed every one of them for its row. For the 81 that are an object without a `model`, a `model` was added to the file. It arrived in the request exactly when the lint says the file is not ignored. This is what the lint says about wrong types: Claude Code ignores the whole file for a value of the wrong type in most keys, and only that field in `hooks`, `allowedMcpServers`, `deniedMcpServers` and `extraKnownMarketplaces` (each was in the table). For a marketplace of `extraKnownMarketplaces` that is wrong it drops only that entry. `managedMcpServers` is ignored in a user, project or local file whatever its value (a string and a list of objects were in the table).
  - **Hooks.** 14 hook lists with something wrong, each put to the binary:
    - a bad entry beside a good one, with another group beside it;
    - a matcher that is a number, a group that is a string, a group with no hooks;
    - an event that does not exist, an event that is an object, an event in lower case;
    - a field the schema lacks (in an entry and in a group), a type in the wrong case, an `async` that is a string;
    - a bad entry in `Stop`, a bad entry in `PreToolUse`, a bad matcher in `PermissionRequest`.

    The hooks that ran were the ones the lint says remain. A bad entry costs only the entry: the other entries of its group and the other groups ran. In `PreToolUse` it costs the whole file, and so does a bad matcher in `PermissionRequest`. A matcher that is not a regular expression never matched, and the lint says so.
  - **Values.** `env` values that are not strings arrived as `String(value)`: `1`, `1.5`, `false`, `null`, `1,2` for a list, `[object Object]` for an object. A key written twice in an object: the last one was kept.
  - **The project and the local file in a git repository.** Started in `repo/sub` of a git repository, with a project file and a local file in both `repo/.claude` and `repo/sub/.claude`. On Windows (2.1.295 and 2.1.299) Claude Code read the two of `sub/.claude` and neither of the two at the repository root: the hooks of `sub-project` and `sub-local` ran. On Linux and macOS (2.1.301, in CI) it read the project file of `sub/.claude` and the local files of both folders: `sub-project`, `sub-local` and `root-local` ran, `root-project` did not. `show` named the same files in all of them.
  - **A skill whose command fails.** The model never received a copy of the skill whose command is `lint` without `--markdown`, on a project with a finding (the command exits 1). No request carried the skill's text on Claude Code 2.1.295 and 2.1.299 on Windows and on 2.1.301 on Linux and macOS in CI; those runs sent no request at all. The same copy with `--markdown` reached the model.
  - **`claude --help`** lists 18 commands, the same ones on 2.1.295, 2.1.299 and (in CI) 2.1.301. None of their names says config or settings. `claude doctor` is the one that reads settings files, and it lists only the ones it could not use.
  - **The plugin.** `claude plugin validate` and `--strict` pass. With the plugin loaded, a plain prompt's request was the same size with and without it, and it had the same tool list. The word `settings-doctor` did not occur in it. The sizes were 68,582 characters on 2.1.295, 69,112 on 2.1.299, 64,376 on 2.1.301 on Linux and 65,355 on macOS. `/settings-doctor:check` reached the model with the lint report for the project in it and the instruction after it, also when the lint found problems. The figures in "What it costs in tokens" are from that capture. The model could run the command from the skill's `allowed-tools` with no prompt in the default permission mode, with the Bash tool and, on Windows, the PowerShell tool. Claude Code runs the command line of a skill and pastes its output when the shell tool is allowed for it (what `allowed-tools` does here). Otherwise it hands the model `[run this first, exactly as written, ...]` with the command filled in. I saw both, and the skill's text reads right in both. `claude plugin details` for the installed plugin: `Always-on: ~11 tok`, `check < 20` always-on and about 90 when used.
- **From GitHub.** `npx -y github:nrzz/claude-settings-doctor lint --project .` ran from the published repository with a throwaway npm cache and home folder. It took 8 and 9 seconds in two runs on Windows. It printed the `lint` report of a folder like the example above, and exited 1 because it had findings.

## Not verified

- **Managed settings.** Their place on each system and their precedence over the other files come from the documentation. They are read (and tested) from `managed-settings.json` and its drop-in folder, but the binary was not put to them: that needs a system folder these checks do not write to. Server-managed settings, macOS profiles and the Windows registry are not read. Whether a wrong type in a managed file drops the field or the file was not tried either.
- **Merge rules beyond hooks.** That an item two files both hold counts once is seen for hooks only. That a value of another type replaces the lower file's is the documentation's account. The binary was not asked about either for other keys.
- **Exceptions to the repository-root rule.** A repository root that is your home folder, or that belongs to another user, is taken from claude-permission-doctor's loader. The binary was not put to either.
- **Other keys for managed settings only.** The schema's description says "Managed settings only" for 24 top-level keys, among them `allowManagedHooksOnly` and `strictKnownMarketplaces`. The lint says nothing about them in a user, project or local file, and `claude doctor` said nothing about those two. Only `managedMcpServers` is reported as ignored there.
- **Flags and plugins.** `--settings`, `--setting-sources`, `--add-dir` and the settings a plugin supplies are not read, and `show` says so.
- **The interactive interface.** I did not drive it. What it shows at start-up about a settings file Claude Code ignores is not known (a `-p` run said nothing; `claude doctor` lists it), and neither is how much of the merge `/status` and `/config` show. The "Always allow" and `/config` writes in the examples and tests are made by a script that writes `settings.json` the way Claude Code does.
- **A session that is already running.** Whether it picks up a `settings.json` that `build` wrote while it runs, or only reads it at start, was not checked: every real-binary check starts a new `claude -p` after the files are written.
- **Other versions.** The local runs are Claude Code 2.1.295 and 2.1.299, the CI run 2.1.301. CI runs the checks with the newest npm release every week, so a later release that reads settings differently shows up there as a red job. The lint table is what those versions did.
- **Linux and macOS** are covered by CI only; nothing was run on either by hand.
- **The schema** is SchemaStore's of the download date. A key Claude Code accepts that the schema lacks is flagged as unknown (the lint says the schema may lag). A value the schema allows that Claude Code rejects is a finding only where the 97 settings show it (`permissions.defaultMode: "delegate"`).
- **Hook types other than `command`.** `http`, `prompt`, `agent` and `mcp_tool` entries are checked against the schema's shapes. Only command hooks were run; two rows of the lint table (a `prompt` hook without a prompt, an `http` hook without a url) were put to `claude doctor`.
- **`watch` on a network drive or under WSL** with folder events or with `--poll`: the events and the polling were tested on local folders only.
- **The skill with a model.** It was run through the real binary at zero tokens, as above; what Claude then says about the report was not checked.
- **The marketplace line.** `/plugin install settings-doctor@claude-code-toolkit` has not been tried: the toolkit's marketplace lists the plugin only after the hub is updated. The plugin installs and validates from a local marketplace folder.

## Files

| Path | What it is |
| --- | --- |
| `bin/claude-settings-doctor.mjs` | The command |
| `src/cli.mjs`, `src/commands.mjs` | The options, the help and the exit codes; show, lint and explain as plain objects |
| `src/settings.mjs`, `src/merge.mjs` | Finding and reading the settings files; the merge and where each value came from |
| `src/jsonc.mjs`, `src/jsonedit.mjs`, `src/build.mjs` | Reading JSON with comments by its text; editing it by text; writing settings.json from it |
| `src/schema.mjs`, `src/schema/` | The checker for SchemaStore's schema; the vendored schema, its licence and the record of the download |
| `src/lint.mjs`, `src/facts.mjs` | The checks; what the real binary was seen to do, as tables |
| `src/init.mjs`, `src/absorb.mjs`, `src/diff.mjs` | Annotating from the schema; taking Claude Code's edits into settings.jsonc; comparing two settings |
| `src/write.mjs` | The only code that writes: backups, atomic writes, restore, the record of the last build |
| `src/actions.mjs`, `src/watch.mjs` | init, build, check, absorb and restore on top of it; watch |
| `src/version.mjs` | The version number, which `package.json` and `plugin.json` must agree with |
| `src/report.mjs` | The text, markdown and JSON reports |
| `scripts/update-schema.mjs` | Downloads the schema by hand; not part of the package |
| `skills/check/` | `/settings-doctor:check`, the user-only skill |
| `.claude-plugin/` | The plugin manifest and its icon |
| `test/` | `npm test`; `lint-table.mjs` is the settings the lint is held to (what it says, and what `claude doctor` lists), `e2e-claude.test.mjs` puts them and the rest to the binary |

Related: [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor) explains why a permission prompt appeared and finds dead rules, and [claude-hook-bench](https://github.com/nrzz/claude-hook-bench) runs every hook with the JSON Claude Code sends.

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-settings-doctor/issues?q=is%3Aopen+label%3A%22good+first+issue%22). For a wrong finding, send the settings that cause it and what `claude doctor` says; that pair becomes a row of the lint table. Questions go to [Discussions](https://github.com/nrzz/claude-settings-doctor/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay
- [claude-chat-ferry](https://github.com/nrzz/claude-chat-ferry): continue a Cursor or Antigravity chat in Claude Code, or hand a session to them
- [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history
- [claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep
- [claude-hook-bench](https://github.com/nrzz/claude-hook-bench): run every hook with the JSON Claude Code sends, and see what each one does
- [claude-relocate](https://github.com/nrzz/claude-relocate): move Claude Code's config folder to another drive or the XDG folders, safely, with undo

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

If one of them saves you tokens, a star on its repository helps other people find it, and following [@nrzz](https://github.com/nrzz) on GitHub shows you new tools and releases.

## License

MIT
