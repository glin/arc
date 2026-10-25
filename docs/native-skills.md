# Native session skills

Use this guide when changing automatic skill admission, native catalog refreshes, or skill attachment at delivery.

## Native session skill admission

Each live, recovery, replacement, or idle child prepares optional skill delivery before its single spawn. Rename-only children remain skill-free. Preparation freezes the launch environment and the selected immutable release. Windows configuration-home overrides retain case-insensitive environment selection through preparation and spawn. Running children retain that release across extension updates. [Session guidance](arc-sessions.md#automatic-native-availability) owns invocation, collision, and disablement behavior.

Claude starts with one skill-only `--plugin-dir` after bounded static admission. Its actual initialize response must report `>=2.1.310 <3.0.0`. This range is the qualified baseline, not the option's introduction version. Native `get_settings` must supply readable `effective` and `applied` objects before optional command publication. Its `sources` must be an array of source objects. Only `userSettings`, `projectSettings`, `localSettings`, and `flagSettings` sources qualify. Policy or unknown sources refuse delivery.

Claude repeats native settings and static identity admission after attachment preparation, before its first user frame. Competing first writes serialize. A cancelled attempt cannot supply admission to the next prompt. Final generation, cancellation, guard, and reservation checks remain synchronous beside the write. Text, attachments, guarded input, local commands, and effort commands share that boundary.

Codex initializes its dedicated app-server before forced raw skill discovery and effective configuration reads. Admission reads `config/read` with layers and `configRequirements/read`. Personal configuration and an empty system layer qualify. Managed layers, non-null requirements, malformed entries, and ambiguous effective skill paths refuse delivery. Arc registers only its immutable skills root through `skills/extraRoots/set`. It requires an object acknowledgement, then repeats discovery and configuration admission before opening, resuming, or forking a session. Idle children open no session.

Codex repeats admission for displayed catalog refreshes, including trailing `skills/changed` notifications. Pending refreshes remove attachment authority. Confirmed removal of Arc's roots permits ordinary continuation in the same process. Uncertain registration or removal blocks further delivery. A definite unsupported method before registration retains ordinary startup in that child. Each optional catalog opening or refresh uses one 15-second deadline across trailing notifications and retains existing output limits. Neither provider starts a replacement or retries delivered input to repair optional discovery.

Windows native checks establish prompt-free discovery and registration for the qualified runtimes. Native macOS and Linux checks and authenticated instruction loading remain separate acceptance checks. All platforms use the same admission contracts.

## Codex skill attachment

The opening command catalog comes from `skills/list` with the child's working directory. A `skills/changed` notification starts another `skills/list` with the same directory and `forceReload: true`. A notification received during opening waits for that read before it starts the forced refresh. Notifications received during a refresh produce one trailing refresh. A successful response replaces the complete catalog. A failed response leaves the previous autocomplete catalog visible.

`codexwire.ts` resolves explicit skill invocations at delivery from its child's discovery response, before autocomplete discards enabled state and directory identity. It adds a separate `{ type: 'skill', name, path }` input beside text and staged files. Only one enabled, unambiguous entry in the child's working-directory group supplies the canonical name and path. Browser input supplies neither field. Invocations wait for pending discovery and trailing refreshes. Prompt preparation preserves submission order through the native write. Stop cancels preparation before it writes. Invalidation immediately removes attachment authority, and failed discovery restores no stale paths. Each replacement child discovers its own catalog. Native controls retain precedence. The native attachment requests skill instructions without guaranteeing that the model follows them.

## Catalog availability

- Claude's `init` system message, and the skill list it carries, arrives only once a session has taken its first prompt. It never arrives before a prompt, so an idle child started only to answer controls never reports one. The stored skill list for a session's working directory stands in for a session's own list until that session's `init` message arrives, and a new list replaces the stored list for that directory.

- Codex reports `skills/changed` only while an app-server child is connected. The child refreshes with its original working directory and `forceReload: true`. A failed refresh keeps the last complete catalog, and a later notification can replace it. When no child remains, the next child reads the current catalog while it opens.
