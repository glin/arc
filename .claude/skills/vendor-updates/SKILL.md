---
name: vendor-updates
description: Audit new Claude Code and Codex releases for changes that break, silently change, or extend what Arc reads, launches, and installs. Reads the audit ledger first and covers only the versions after the last audit. Use when: check for Claude Code or Codex updates, audit the changelogs, a new CLI version is installed, what changed upstream, did a CLI update break Arc.
---

# Vendor updates

Arc reads transcripts, rollouts, status line JSON, and headless protocols that Claude Code and Codex own. Neither vendor promises those shapes. This skill finds the release changes that touch them and records each audit in `audited.md`, so the next run starts where the last one stopped.

## 1. Find the new range

Read `audited.md` beside this file. Its Versions table holds the last audited version of each vendor.

Run these in one command:

```bash
claude --version
codex --version
curl -sL https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md | grep -m3 '^## '
gh release list --repo openai/codex --limit 15
```

If neither vendor published a version after its ledger version, report that nothing is new and stop. Audit only a vendor that moved.

## 2. Audit each vendor in its own subagent

Start one research subagent per vendor that moved, in the same message. Give each one:

- The range: every version after the ledger version, through the latest stable.
- The instruction to read `docs/architecture.md` in full, then check each candidate in the file that owns the surface. The Data sources table and the component map name the owners. Include the status line reader `cli/src/status.ts`, the hook registration in `scripts/register-hooks.js`, the launch flags, and `extension/src/pricing.ts`.
- The open findings for that vendor from the ledger, so it reports a release that resolves or changes one.
- The report shape below, under 900 words.

Where the facts live:

- Claude Code: the raw `CHANGELOG.md` above. A version number with no heading was never published.
- Codex: `gh release view <tag> --repo openai/codex`. Prerelease notes are usually empty. For a prerelease after the latest stable, read `gh api repos/openai/codex/compare/<stable>...<prerelease>` for commit subjects and for diffs under `codex-rs/app-server-protocol/schema/`. A PR body holds the detail a release note omits: `gh pr view <n> --repo openai/codex`.
- A Claude setting whose default the changelog leaves vague: the installed binary carries the settings schema text. Run `grep -aoE '.{0,300}<key>.{0,300}'` on the file that `command -v claude` names.

The report shape:

1. The range audited, the latest stable, and the latest prerelease.
2. Breakages and risks: changes that break or silently change what Arc parses, sends, launches, or installs.
3. New surface that Arc can use.
4. Changes that need no action.
5. The answer to each question in Standing checks below.

Each item names the version, quotes the note briefly, names the Arc file it touches, and says `confirmed in code` or `unconfirmed`.

## Standing checks

Every audit answers the questions below, whatever the release notes say. The report names each answer even when nothing changed, because a silent release is the answer.

- Does an effort change retain the prompt cache for each exact model identity and provider route? Follow [Model pricing](../../../docs/development.md#model-pricing) for primary evidence, policy checks, and existing independent test coverage.
- Does any Claude payload carry the credit cap's own reset? Read `extra_usage` and `spend` in the `get_usage` reply, the structured `/usage` twin, and `rate_limit_info` on a live `rate_limit_event`. Capture the account answer on the author's enterprise account, because no other plan reports a credit cap.
- `childEnv` in `agenthost.ts` starts a child with no `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_AGENT_SDK_CLIENT_APP`, `CLAUDE_CODE_REMOTE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, or `CLAUDE_CODE_CONTAINER_ID` (the `HOST_IDENTITY_ENV_NAMES` list), removed case-insensitively, so it records `sdk-cli` and gets no generated title even when the extension host sets one of the other names. At each audit, report whether a release changes what an `sdk-cli` print-mode run gets, for example whether an `ai-title` record returns for it, and name any new read site that treats `sdk-cli` differently from another entrypoint. Capture a sample with Arc's launch flags per section 3. Then run `grep -aoE '.{0,300}CLAUDE_CODE_ENTRYPOINT.{0,300}'`, `grep -aoE '.{0,300}CLAUDE_AGENT_SDK_[A-Z_]+.{0,300}'`, `grep -aoE '.{0,300}CLAUDE_CODE_REMOTE_SESSION_ID.{0,300}'`, `grep -aoE '.{0,300}CLAUDE_CODE_CHILD_SESSION.{0,300}'`, `grep -aoE '.{0,300}CLAUDE_CODE_CONTAINER_ID.{0,300}'`, and `grep -aoE '.{0,250}"sdk-(ts|cli)".{0,250}'` on the installed binary. List any variable among those matches that labels the client, bypasses the `sdk-cli` title gate, or marks the process as a spawned subagent, so the removal set in `agenthost.ts` stays complete, and flag a read site that touches billing, permissions, tool availability, hooks, settings sources or transcript shape.
- Can Arc now price Claude Code prompt suggestions? Each suggestion is a forked request that no transcript records. Report whether a release adds any of these: a transcript, sidechain or `api-request` record with `querySource: "prompt_suggestion"` and usage, per-request usage in `cost-state` or a `cost-state` write before exit, a hook, OpenTelemetry or raw-response capture event that carries per-request usage for forked requests and that Arc can read without a debug mode, or usage on the `prompt_suggestion` stream message. Run `grep -ac prompt_suggestion` and `grep -ac skipTranscript` on the installed binary first, because each takes about 1 second. When a count changes from the last audit or a closer read is needed, run `grep -aoE '.{0,300}prompt_suggestion.{0,300}'` and `grep -aoE '.{0,300}skipTranscript.{0,300}'` as a background command or with a longer timeout, because the first takes about 2.5 minutes on the 290 MB binary. Report any fork that now writes a record. The known caveat lives in `.claude/plans/reference/claude-prompt-suggestion-cost.md`.

## 3. Capture a sample before a plan names a shape

A changelog line does not give a field's shape or its default. Before a finding becomes a plan, run the installed CLI once in a temporary directory and read the record it writes. Use the cheapest model. Run `git init` and commit a file first, because some records exist only inside a git repository. The Bash edit diff is one of them.

- Claude: `claude -p "<prompt>" --model claude-haiku-4-5-20251001 --output-format stream-json --verbose --settings '<json>' < /dev/null`. The transcript lands under `~/.claude/projects/` in a folder named for the temporary directory. To test a headless slash command or control, pipe stream-json user messages into `--input-format stream-json`.
- Codex: `codex exec "<prompt>"` writes a rollout under `~/.codex/sessions/`.

Write the command and the observed record into the finding. Delete the temporary directory and its transcript folder afterward, so the sample does not appear in Arc.

## 4. Record the audit

Edit `audited.md`:

- Set each audited vendor's version, prerelease scanned, and date in the Versions table.
- Add each new finding under Open findings as one line: the version, the change, the effect on Arc, the evidence, and a link to its plan when one exists.
- Move a finding to Closed when its plan lands, when a later release removes the risk, or when the author drops it. Keep the line and add the reason.

Commit the ledger by itself: `chore(skills): record vendor audit through <claude version> and <codex version>`.

Report breakages first, then adoptions ranked by the requirement or reader job each serves in `docs/design-goals.md`. The author chooses which findings become plans. Write a plan file for each one chosen, and link it from its finding.
