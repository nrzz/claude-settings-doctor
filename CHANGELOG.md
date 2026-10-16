# Changelog

All notable changes to claude-settings-doctor are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-16

- First release. A CLI and a Claude Code plugin with one user-only skill, `/settings-doctor:check`.
- `init` writes `settings.jsonc` next to a settings file with every key annotated from SchemaStore's schema. `build` writes `settings.json` from it (comments and trailing commas gone, keys in order, two-space layout) after a backup, and refuses when `settings.json` changed since the last build. `check` exits 1 when `settings.json` holds other settings than `build` would write, and not for a different layout alone. `absorb` takes what Claude Code wrote into `settings.json` (an "Always allow" rule, a `/config` change) back into `settings.jsonc` by editing its text, so comments, blank lines, indentation, line endings and the order of keys stay. `watch` builds on every save. `restore` puts the newest backup back and can itself be undone. Each of them takes `--user`, `--project <dir>` or `--local`, `--json`, and (where it writes) `--dry-run`.
- `show` lists the settings Claude Code merges (managed, local, project, user) with the file each value came from and what a higher file shadows. `lint` finds a comment or trailing comma (Claude Code ignores the whole file), keys the schema does not know, wrong types, bad values, deprecated keys, `env` values that are not strings, hook entries of the wrong shape and repeated keys, with the file, line and what Claude Code does about each. `explain <key>` prints the schema's description and the files that set the key now.
- What Claude Code does about each mistake is what the real binary did: `test/e2e-claude.test.mjs` puts 91 settings with one thing wrong in each to Claude Code 2.1.295 and 2.1.299, and the same checks run in CI on Linux and macOS with the newest npm release (README "What was verified").
- Zero tokens for the tool. The skill is user-only, adds nothing to a request that does not use it, and hands the model a report of at most 12 findings.

[1.0.0]: https://github.com/nrzz/claude-settings-doctor/releases/tag/v1.0.0
