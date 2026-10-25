# Native session skills

Use this guide for automatic skill admission, catalog freshness, and delivery attachments. [Session guidance](arc-sessions.md#automatic-native-availability) owns invocation, collisions, and disablement.

## Native session skill admission

Live, recovery, replacement, and idle children prepare optional skills before their single spawn. Rename-only children stay skill-free. Freeze the environment and immutable release during preparation. Preserve Windows case-insensitive configuration-home selection through spawn. Running children retain their release across extension updates.

Claude adds one skill-only `--plugin-dir` after bounded static admission. Its actual initialize response must report `>=2.1.310 <3.0.0`, the qualified baseline. Native `get_settings` requires readable `effective` and `applied` objects and a source-object array. Only `userSettings`, `projectSettings`, `localSettings`, and `flagSettings` qualify. Policy and unknown sources refuse optional delivery.

Repeat native settings and static identity admission after attachment preparation, before the first user frame. Serialize competing first writes. Cancelled attempts cannot authorize later prompts. Check generation, cancellation, guards, and reservations synchronously beside the write. Apply this boundary to text, files, guarded input, local commands, and effort commands.

Codex initializes before forced raw skill discovery and effective configuration reads. Read `config/read` with layers and `configRequirements/read`. Personal configuration and an empty system layer qualify. Managed layers, non-null requirements, malformed entries, and ambiguous skill paths refuse delivery. Register only Arc's immutable root through `skills/extraRoots/set`. Require an empty object acknowledgment. Repeat discovery and configuration admission before start, resume, or fork. Idle children open no thread.

Repeat admission on displayed catalog refreshes, including trailing notifications. Confirmed root removal permits ordinary continuation in the same process. Uncertain registration or removal blocks further delivery. A definite unsupported method before registration keeps ordinary startup in that child. Each optional opening or refresh shares one 15-second deadline across trailing notifications and keeps output limits. Neither provider replaces a child or retries delivered input to repair optional discovery.

Windows native qualification covers prompt-free discovery and registration. Native macOS and Linux qualification and authenticated instruction loading remain separate acceptance checks. All platforms use the same admission rules. [`sessionskills.ts`](../extension/src/sessionskills.ts) owns static and configuration checks.

## Codex skill attachment

Read `skills/list` in the child's working directory. Connected `skills/changed` notifications force reload in that directory. Opening defers notifications until its read finishes. Refresh bursts coalesce into one trailing refresh. Success replaces the catalog. Failure retains autocomplete display, without restoring stale attachment paths. A replacement child discovers its own catalog.

Resolve explicit invocations from the raw child catalog before autocomplete drops enabled state and directory identity. Attach `{ type: 'skill', name, path }` beside text and files only for one enabled, unambiguous working-directory entry. The browser supplies neither canonical name nor path. Wait for discovery and trailing refreshes, preserving input order through writing. Invalidation removes attachment authority immediately. Stop cancels preparation before input. Native controls take precedence. Attachment requests instructions without guaranteeing model compliance.

## Claude catalog availability

Claude's `system/init` skill list arrives after its first prompt, never on a control-only idle child. Until then, use the stored working-directory list. A new list replaces that directory's stored list.

Use `sessionskills.test.ts`, `claudewire.test.ts`, `codexwire.test.ts`, and `agenthost.test.ts` for admission, refresh, and first-write races.
