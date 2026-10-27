# Session setup and controls

[`composerview.ts`](../extension/src/composerview.ts) projects controls and launch setups. [`webview/chrome.ts`](../extension/src/webview/chrome.ts) owns the New session menu. [Account usage](account-usage.md) owns account-wide limits.

## Starting the first session

Opening Servers can start a provisional Claude child without creating a transcript or durable session record.

After first-prompt acceptance, keep the provisional shell interactive until one complete render identifies its durable replacement. Delayed queue edits follow adoption. Delayed refusals restore text only when its revision remains unchanged.

New inherits the selected session's setup and stored permission, including an agent-default permission. Without a stored permission, it uses `Auto` for Claude or `Approve for me` for Codex. Without a selection, it uses the latest available recent setup, even when a pin hides that row. Pins never change New's primary setup. Recent setups keeps an unpinned setup that matches Same setup as current.

Current-setup launches and handoffs wait for pending model evidence before capturing the setup. Explicit model picks, recent setups, and pinned setups start without waiting. The initiating session and panel retain ownership.

Pins and recents belong to the launch project, using the first folder in a multi-root workspace. Handoffs keep their source folder. Successful draft submission updates that destination's recents even after project selection changes.

[`domain/session-setups.ts`](../extension/src/domain/session-setups.ts) owns setup validation and recent-list limits. [Navigation](panel-navigation.md#context-menus-and-copy) owns response-link handoff content, setup, folder, labels, and source navigation.

## Session controls

Setup fields use the shared [combobox contract](panel-accessibility.md#keyboard-and-screen-reader-contract). Choosing the already selected row preserves saved launch values. Choosing a different default Model omits model and effort overrides. Choosing a different default Effort omits only effort.

Catalogs belong to agents. Selected and pending choices belong to sessions. Recorded turns settle pending choices. Claude effort commands that start turns wait for running work to finish.

Codex presets map approval policy, approval reviewer, and sandbox policy. Without an Arc choice, Codex configuration and folder trust decide effective values. Thread and turn sandbox spellings differ. Preserve the wire adapter's translation.

A stopped Codex turn without a model displays the session's last reported model. That identity supplies no effort, context, or price. Newer reported models and existing selected or pending choices retain precedence.

Draft setup comes only from its profile, ignoring session picks and per-agent permission choices. Pending or successful first submissions block setup changes because the child uses the captured setup. Failed first submissions permit retry changes. Typing or draft-control changes retain a draft after selection changes. The launcher's custom form alone does not retain an untouched draft.

[`webview/composer-controls.ts`](../extension/src/webview/composer-controls.ts) owns Remote Control presentation. [`webview/composer-presentation.ts`](../extension/src/webview/composer-presentation.ts) owns next-turn price changes and focus transfer. [Context evidence](accounting.md#context-evidence) owns pricing and cache qualifications.

## MCP controls

Opening Servers reuses a running Claude draft child through pending server startup and first-prompt delivery. Drafts and recorded sessions keep separate readings.

Claude supports status, toggle, and reconnect. Codex supplies status only. Only `disabled` means off. Preserve unfamiliar states without treating them as disabled.

Claude persists some MCP changes only during orderly shutdown. Close child input before killing an unresponsive process. Status reads started before a toggle cannot overwrite its result.

[`agenthost.ts`](../extension/src/agenthost.ts) owns MCP discovery and child shutdown. Authentication and server configuration have no panel workflow.

## Context detail

[`webview/context-detail.ts`](../extension/src/webview/context-detail.ts) renders detail. [`webview/composer-controls.ts`](../extension/src/webview/composer-controls.ts) owns its disclosure and focus.

Category meters require their sum to equal occupied tokens. Mismatches retain a percentage-only table. Free space supplies Remaining, separately from compaction reserve.

Inspection starts no child or model turn. Invalidation affects only that session and rejects obsolete replies. [Context evidence](accounting.md#context-evidence) owns provider estimates and unavailable states.

## Project setup storage

[`projectsetups.ts`](../extension/src/projectsetups.ts) serializes each host's project pins and recents together. Simultaneous windows can lose one same-project change. Other-window pins appear on the next pin change or refresh. Actions carry displayed project ownership. Recent-row pinning carries displayed values so shifted history cannot pin another setup.

Project identity uses the canonical common Git directory across checkouts, registered worktrees, and opened subdirectories. Non-Git folders use canonical folder paths. Failed identity reads retain successful identities or leave storage unavailable. Folderless windows have no reusable setup.

Initialization saves copied legacy pins and empty recents together. Existing entries, including invalid or empty entries, never import again. Legacy storage remains unchanged.

## Model resolution

Setup summaries and draft Model controls describe an omitted model as the agent's default. When a ready reading resolves a model, summaries include its label and a default marker. Loading, unavailable, or absent readings name only the agent default. Launching, editing, pinning, and saving preserve omitted model and effort overrides.

Use [`view/model-picks.ts`](../extension/src/view/model-picks.ts)'s `recordedChoice` across controls, inherited setups, and price projection. It handles model windows, Bedrock prefixes, snapshots, aliases, and deployment suffixes. Keep ambiguous API identities unresolved. Several rows with one identity resolve to the visible model-menu row.

`defaultIdentity` projects applied defaults onto that row without changing saved or wire values. While the Model field shows the saved selection, a `default` value reads as its menu row. The applied default read does not change that. A row that combines aliases with a model row shows that model's label. A sole `default` row shows its resolved model id. A `default` row without a resolved model keeps its own label. A saved model id, such as `claude-opus-5-5`, resolves to the named row that shares it with the `default` row. Window-added values such as `opus[1m]` resolve across controls, launching, and setup checks. Inheritance retains a recorded differing window. Per-model defaults and switch values still require exact resolution.

## Draft initialization

Register reader-started parents before the first selected-only refresh. It projects the selected row synchronously from held catalogs. Later persistence or focus messages do not rebuild parent projection.

## Catalogs and applied defaults

The first visible ready panel requests catalogs independently of history loading. MCP-only requests skip catalog children. Saved same-CLI-path catalogs remain pending until the first fresh answer. Pending catalogs keep stored setups startable. Loaded catalogs restore missing-value checks. Failed reads restore checks only without a saved catalog.

Profile changes retire distinct provisional children unless a child accepted its first prompt. Acceptance uses the agent and draft key and survives later save or adoption failures.

Key defaults by agent, working directory, and committed model value. Requests also carry the configuration revision. Windows folder comparisons ignore case. Saved readings remain visible while one fresh read runs per key. Fresh answers replace displayed and saved values, including unavailable answers.

Unobserved configuration changes, including environment changes, can leave saved readings stale. Selecting the displayed default omits the override, so the CLI applies its actual default. [Configuration watches](development.md#configuration-watches) owns invalidation.

Claude metadata children omit effort overrides. Codex metadata uses app-server defaults, excluding TUI-only managed model defaults. Missing metadata leaves omitted launch values valid. Visible model rows combine aliases without changing raw pricing or attachment catalogs.
