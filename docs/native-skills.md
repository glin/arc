# Native session skills and snapshot hooks

[Session guidance](arc-sessions.md#automatic-native-availability) owns invocation, collisions, and disablement.

## Native session skill admission

Live, recovery, replacement, and idle children prepare optional components before their single spawn. Rename-only children receive neither component. Freeze the environment and immutable release during preparation. Preserve Windows case-insensitive configuration-home selection through spawn. Running children retain their release across extension updates.

Claude independently selects a skill-only plugin and the canonical snapshot plugin through repeated `--plugin-dir` arguments after one bounded static read. Each selected plugin retains the same immutable release identity. Its actual initialize response must report `>=2.1.310 <3.0.0`, the qualified baseline. Native `get_settings` requires readable `effective` and `applied` objects and a source-object array. Only `userSettings`, `projectSettings`, `localSettings`, and `flagSettings` qualify. Policy and unknown sources refuse optional delivery.

Personal, ancestor, main-worktree, inline and applicable plugin settings participate in admission. Directory marketplaces resolve their selected source. Existing `arc-hooks` registrations and settings suppress automatic hooks regardless of enabled state or marketplace. Direct hook entries and renamed plugin declarations also suppress the automatic pair when either Arc capture command exists. Default hook files, manifest-selected paths and inline declarations participate. Malformed or unreadable declarations refuse hooks independently of the skill.

`disableAllHooks`, `allowManagedHooksOnly`, unsupported hook settings and sideload restrictions refuse automatic hooks. Every raw personal source retains explicit refusal. Unknown and managed origins refuse both components. Arc never changes native configuration or overrides disablement at launch. Hook-only children receive the same actual-child checks as skill-bearing children.

Hooks require an external Node.js runtime selected from the frozen child's environment. Relative PATH entries, canonical project-local runtimes and unsupported versions refuse hooks. External executable symlinks qualify when their canonical targets remain external. Nonempty `NODE_*` variables in inherited environments and reached settings also refuse hooks. Malformed settings environments refuse hooks independently of the skill. Windows environment names compare without case and conflicting aliases refuse admission. macOS and Linux preserve case. Runtime version execution receives that admitted environment. Each prepared child reuses successful qualification while executable filesystem identity, working directory, platform, and the checked environment agree. Filesystem selection repeats at native admission and first input. Changed identity requires another version check. Omitted hooks skip further runtime checks and configuration hook scans. Complete release validation still checks the bundled hook declaration. Ordinary launch and skill admission remain independent of inherited Node refusal.

Repeat native settings and static identity admission after attachment preparation, before the first user frame. Serialize competing first writes. Cancelled attempts cannot authorize later prompts. Check generation, cancellation, guards, and reservations synchronously beside the write. Apply this boundary to text, files, guarded input, local commands, and effort commands.

Codex initializes before forced raw skill discovery and effective configuration reads. Read `config/read` with layers and `configRequirements/read`. Personal configuration and an empty system layer qualify. Managed layers, non-null requirements, malformed entries, and ambiguous skill paths refuse delivery. Any pre-existing corresponding raw catalog entry suppresses registration, including an enabled link to the selected definition. After registration, retain only the exact enabled Arc-owned entry. Register only Arc's immutable root through `skills/extraRoots/set`. Require an empty object acknowledgment. Repeat discovery and configuration admission before start, resume, or fork. Idle children open no thread.

Repeat admission on displayed catalog refreshes, including trailing notifications. Confirmed root removal permits ordinary continuation in the same process. Uncertain registration or removal blocks further delivery. A definite unsupported method before registration keeps ordinary startup in that child. Each optional opening or refresh shares one 15-second deadline across trailing notifications and keeps output limits. Neither provider replaces a child or retries delivered input to repair optional discovery.

Windows native qualification covers prompt-free skill discovery, registration, and loading both session plugins. It does not establish native snapshot event dispatch. Native macOS and Linux qualification and authenticated instruction loading remain separate acceptance checks. All platforms use the same admission rules. [`sessionskills.ts`](../extension/src/sessionskills.ts) owns static and configuration checks.

## Codex skill attachment

Read `skills/list` in the child's working directory. Connected `skills/changed` notifications force reload in that directory. Failed refreshes retain autocomplete display without restoring attachment authority. [`codexwire.ts`](../extension/src/codexwire.ts) owns refresh scheduling and attachment preparation.

Resolve invocations from the raw child catalog before autocomplete drops enabled state and directory identity. Attach `{ type: 'skill', name, path }` only for one enabled, unambiguous working-directory entry. The browser supplies neither canonical name nor path. Wait for discovery and trailing refreshes, preserving input order through writing. Invalidation removes attachment authority immediately. Stop cancels preparation before input. Native controls take precedence. Attachment requests instructions without guaranteeing model compliance.

## Claude catalog availability

Claude's `system/init` skill list arrives after its first prompt, never on a control-only idle child. [`panelhost.ts`](../extension/src/panelhost.ts) owns working-directory catalog fallback.

Use `sessionskills.test.ts`, `claudewire.test.ts`, `codexwire.test.ts`, and `agenthost.test.ts` for admission, refresh, and first-write races.
