# Contributing

Thanks for using `hn-mcp-server`. Bugs, feature requests, and documentation gaps all belong in an issue — that's where they get read and picked up.

Open one from the [Issues tab](https://github.com/cyanheads/hn-mcp-server/issues/new/choose) and pick the **Bug Report** or **Feature Request** form. Both are structured, and filling in the fields is what makes an issue actionable.

## Server bug or framework bug?

`hn-mcp-server` is built on [@cyanheads/mcp-ts-core](https://github.com/cyanheads/mcp-ts-core), which handles transports, auth, config, logging, and telemetry. Sorting out which layer broke saves everyone a round-trip:

- **This repo** — a Hacker News tool returns wrong data, a Firebase or Algolia request fails, a schema doesn't match reality, or a description misleads the model.
- **[mcp-ts-core](https://github.com/cyanheads/mcp-ts-core/issues)** — a builder rejects valid input, `createApp()` fails on a valid config, a `Context` method behaves contrary to its docs, or transport/auth misbehaves regardless of which tool you call.

If you're not sure, file here and it'll get routed.

## Before filing

1. **Check you're on the latest release.** Fixes land on the current version.
2. **Search existing issues** before opening a new one. Add to the matching thread instead of filing a duplicate.
3. **Redact anything sensitive.** Issues are public and permanent — no API keys, tokens, auth headers, internal URLs, or PII in code, logs, or stack traces.

## What makes an issue actionable

- Server version, `mcp-ts-core` version, runtime (Bun or Node), and transport (stdio or HTTP).
- The tool involved and the arguments you called it with.
- Actual vs. expected behavior, including error messages and stack traces as they appeared.
- For features: the use case first, then the API as you'd want to call it.

## For agents

Do the triage first — an unverified report costs more to read than it saves to file.

Two workflows ship with this project:

- [`framework-skills/report-issue-local/SKILL.md`](../framework-skills/report-issue-local/SKILL.md) — filing against this repo.
- [`framework-skills/report-issue-framework/SKILL.md`](../framework-skills/report-issue-framework/SKILL.md) — filing against `mcp-ts-core` after isolating the bug to the framework.

Read the relevant one before filing on a user's behalf.

## Security

Don't open a public issue for a vulnerability. Use GitHub's **Security** tab → **Report a vulnerability**, or email **security@caseyjhand.com**.
