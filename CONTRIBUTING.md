# Contributing to claude-settings-doctor

Thanks for helping. claude-settings-doctor is a CLI and a Claude Code plugin with one user-only skill, part of the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit). The bar for a change is the bar the code already meets: it works on Windows, macOS and Linux, it is tested, and it never wastes anyone's tokens.

## Start here

- **Good first issues:** [the issues labelled good first issue](https://github.com/nrzz/claude-settings-doctor/issues?q=is%3Aopen+label%3A%22good+first+issue%22), and the ideas in [ROADMAP.md](ROADMAP.md).
- **Questions and ideas:** [Discussions](https://github.com/nrzz/claude-settings-doctor/discussions).
- **Bugs:** [open an issue](https://github.com/nrzz/claude-settings-doctor/issues/new/choose) with the Claude Code version (`claude --version`), your OS, `node --version`, and the exact command and output. For a wrong finding or a wrong merge, add the settings that cause it (a few lines) and what Claude Code did with them; that pair is the test case.

## Set up

There is nothing to install: the project has no dependencies.

```bash
git clone https://github.com/nrzz/claude-settings-doctor
cd claude-settings-doctor
npm test
```

- `node bin/claude-settings-doctor.mjs show --project <a project>` shows the merged settings of a project, `lint` the problems in them.
- `E2E_CLAUDE=claude node --test test/e2e-claude.test.mjs` also puts the tool's claims about Claude Code to the real binary (see below).
- Point `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` at a temporary folder whenever you run the tool, the tests or `claude` by hand; the tests do it for themselves.

## Where things are

| Path | What it holds |
| --- | --- |
| `bin/claude-settings-doctor.mjs` | the CLI entry |
| `src/cli.mjs` | the options, the help, the exit codes |
| `src/commands.mjs`, `src/report.mjs` | show, lint and explain as plain objects; the text, markdown and JSON reports |
| `src/settings.mjs`, `src/merge.mjs` | finding and reading the settings files; the merge and where each value came from |
| `src/jsonc.mjs`, `src/jsonedit.mjs`, `src/build.mjs` | reading JSON with comments by its text; editing it by text; writing settings.json from it |
| `src/schema.mjs`, `src/schema/` | the checker for SchemaStore's schema, and the vendored copy with its licence and date |
| `src/lint.mjs`, `src/facts.mjs` | the checks; what the real binary was seen to do, as tables |
| `src/init.mjs`, `src/absorb.mjs`, `src/diff.mjs` | annotating from the schema; taking Claude Code's edits back into settings.jsonc; comparing two settings |
| `src/write.mjs`, `src/actions.mjs`, `src/watch.mjs` | the only code that writes (backups, atomic writes, restore, the record of the last build); init, build, check, absorb and restore; watch |
| `scripts/update-schema.mjs` | downloads the schema by hand; the only code that opens a network connection, and not part of the package |
| `skills/check/`, `.claude-plugin/` | the user-only skill; the plugin manifest and icon |
| `test/*.test.mjs` | unit tests; `e2e-claude.test.mjs` runs against the real binary when `E2E_CLAUDE` is set |
| `test/lint-table.mjs` | 96 settings with one thing wrong in each: what the lint says, and what `claude doctor` lists |

## House rules

1. **No dependencies.** Node built-ins only, Node 18 or newer, ES modules (`.mjs`). A pull request that adds a package to `dependencies` will not be merged. Nothing in `src/` or `bin/` may start a process or open a network connection; a test fails otherwise.
2. **Every change comes with a test**, and `npm test` passes. CI runs the suite on Windows, macOS and Linux with Node 20, 22 and 24, and on Linux with Node 18, and the real-binary checks on Linux and macOS; a change that only works on one of them is not done.
3. **The binary is right.** The lint says what Claude Code does about a mistake because the real binary was put to it. When the lint is wrong, add the setting to `test/lint-table.mjs` with what `claude doctor` lists for it, run `E2E_CLAUDE=... node --test test/e2e-claude.test.mjs`, fix the tables in `src/facts.mjs` or the check, and say so in the README's "What was verified". Do not change a row to make a test pass without running it against the binary.
4. **Token cost is a feature.** The tool runs outside Claude; the one skill is user-only and its report is capped. If your change puts anything new in front of Claude, say how many tokens in the pull request and update the README's "What it costs in tokens".
5. **Settings files are the user's.** Whatever writes one backs it up first, next to it; changes only what it is there for; leaves a file that is not valid JSON alone; offers `--dry-run`; and can be undone with `restore`.
6. **Never touch real user data in tests.** Use a temporary folder and point `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` at it, in the same command, whenever you run the tool, `claude` or anything else that reads them. `test/helpers.mjs` points every way the tool finds a config folder at a throwaway one the moment it loads.
7. **Keep the README honest.** Its "What was verified, and how" section says what was checked and what was not. If your change affects either, update it in the same pull request.

## The schema

`src/schema/claude-code-settings.json` is SchemaStore's schema, downloaded on the date in `src/schema/meta.json`. Do not edit it by hand. To take a newer one, run `node scripts/update-schema.mjs` (it needs the network, and prints the keys that were added and removed), then `npm test` and the real-binary checks: a new key may need a row in the lint table, a new hook event an entry in `src/facts.mjs`.

## The real-binary checks

`test/e2e-claude.test.mjs` starts a fake Messages API on 127.0.0.1 and runs the real Claude Code binary against it, with a throwaway `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR`. It puts the claims of the README to it: a comment in settings.json makes Claude Code ignore the file, which file wins, which hooks run, what `claude doctor` lists for each setting in the lint table, and what `/settings-doctor:check` hands the model. No model is reached and nothing leaves your machine.

```bash
E2E_CLAUDE=/path/to/claude node --test test/e2e-claude.test.mjs
```

## Pull requests

- One logical change per pull request, with its test. Commit messages in the imperative mood ("Warn about a deprecated hook event").
- Fill in the pull request template; CI must be green on every job.
- Signed commits are welcome but not required.
- Plain, specific writing in docs, messages and comments.

## Releases (maintainers)

Bump the version in `src/version.mjs`, `package.json` and `.claude-plugin/plugin.json` (`npm test` fails until every copy agrees), add a section to [CHANGELOG.md](CHANGELOG.md), tag `vX.Y.Z` and publish a GitHub release with the changelog section as its notes.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.
