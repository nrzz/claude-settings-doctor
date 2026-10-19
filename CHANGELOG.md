# Changelog

All notable changes to claude-settings-doctor are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-10-19

- `show --only <key>` prints only the merged entries at or below a key (`permissions`, `permissions.defaultMode`, `hooks.PreToolUse`, `env`), each with the file it came from and what a higher file shadows; the list of files at the top stays whole, the heading says the key, and a key with nothing under it prints `nothing is set under <key>` and exits 0. With `--json`, `entries` and `tree` hold only what is under the key and the document gets `"only": "<key>"`. `--only` with no value, or an empty one, is a usage error (exit 2), and the other commands refuse it by name.
- Contributed by [@Dasprakash-Sekar](https://github.com/Dasprakash-Sekar) in [#2](https://github.com/nrzz/claude-settings-doctor/pull/2), the first outside pull request, for the good first issue [#1](https://github.com/nrzz/claude-settings-doctor/issues/1).

## [1.0.0] - 2026-10-16

- First release. A CLI and a Claude Code plugin with one user-only skill, `/settings-doctor:check`.
- `init` writes `settings.jsonc` next to a settings file with a comment, taken from SchemaStore's schema, above each key the schema describes. `build` writes `settings.json` from it (comments and trailing commas gone, keys in order, two-space layout), saving the old file first, and refuses when `settings.json` changed since the last build. `check` exits 1 when `settings.json` holds other settings than `build` would write, and not for a different layout alone. `absorb` takes what Claude Code wrote into `settings.json` (an "Always allow" rule, a `/config` change) back into `settings.jsonc` by editing its text, so comments, blank lines, indentation, line endings and the order of keys stay. `watch` builds on every save. `restore` puts the newest backup back and can itself be undone. Each of them takes `--user`, `--project <dir>` or `--local`, `--json`, and (where it writes) `--dry-run`.
- `show` lists the settings Claude Code merges (managed, local, project, user) with the file each value came from and what a higher file shadows. `lint` finds a comment or trailing comma (Claude Code ignores the whole file), keys the schema does not know, wrong types, bad values, deprecated keys, `env` values that are not strings, hook entries of the wrong shape, repeated keys and `managedMcpServers` outside managed settings, with the file, the line where there is one and, for a mistake that costs something, what Claude Code does about it. `explain <key>` prints the schema's description and the files that set the key now.
- What Claude Code does about a mistake is what the real binary did: `test/e2e-claude.test.mjs` puts 97 settings (86 with something wrong in them, 11 that the binary takes as they are) to Claude Code 2.1.295 and 2.1.299, and the same checks run in CI on Linux and macOS with the newest npm release (README "What was verified").
- Zero tokens for the tool. The skill is user-only, adds nothing to a request that does not use it, and hands the model a report of at most 12 findings.

[1.1.0]: https://github.com/nrzz/claude-settings-doctor/releases/tag/v1.1.0
[1.0.0]: https://github.com/nrzz/claude-settings-doctor/releases/tag/v1.0.0
