# Session setup and controls

Read the section for the control or setup state you change. [`composerview.ts`](../extension/src/composerview.ts) projects controls. [`model-picks.ts`](../extension/src/view/model-picks.ts) resolves model choices. [Account usage](account-usage.md) owns account-wide limits.

## Starting the first session

New creates a selected, editable provisional draft from an available setup. Opening Servers can start a provisional Claude child without creating a transcript or durable session record.

After first-prompt acceptance, keep the provisional shell interactive until one complete render identifies its durable replacement. Interim updates retain the prompt box, heading, labels, pending prompt, and session actions. Delayed queue edits follow adoption. Delayed refusals restore text only when its revision remains unchanged.

Without a remembered setup, New opens the New session menu with Agent focused and unchosen. Choosing an agent fills its Model and Effort defaults. Permissions preselects `Auto` for Claude and `Approve for me` for Codex. `Claude default` and `Codex default` remain the first Permissions choice. Create draft requires a valid complete setup.

New inherits the selected session’s setup and stored permission, including an agent-default permission. Without a stored permission, it uses `Auto` for Claude or `Approve for me` for Codex. Without a selection, it uses the latest available recent setup, even when a pin hides that row. An unavailable current setup opens New with... instead. Inheritance retains effort only when the model offers it.

Current-setup launches and handoffs wait for pending model evidence before capturing the setup. Explicit model picks, recent setups, and pinned setups start without waiting. The initiating session and panel retain ownership.

Pinned setups retain pin order until Unpin. The menu shows up to eight of ten recent setups, excluding matches for pins or the current setup. Unavailable pins remain editable and removable, with their stored values and refusal reason visible. A pin press leaves the menu open and starts no session. Pins never change New’s primary setup. Opening, editing, pinning, dismissing, or cancelling the menu creates no draft.

The setup list scrolls independently so custom fields and Create draft remain visible at every pin count.

Edit loads a setup into the custom fields, including unavailable stored values. Substituted values retain a caution naming the stored value. Changing Model retains supported Effort or chooses the model’s first effort. The field pin toggles the displayed setup. Pinning edited values preserves the original pin. The field pin and Create draft require a chosen agent.

Pins and recents belong to the launch project, using the first folder in a multi-root workspace. Handoffs keep their source folder. Successful draft submission updates that destination’s recents even after project selection changes. Changing launch projects closes the menu and clears retained custom fields. Running-session settings remain independent.

A response-link handoff creates an editable draft containing the rendered local address and one blank line. [Navigation](rail-and-navigation.md#context-menus-and-copy) owns inherited setup, folder, labels, and source navigation. Missing source responses, unlisted sessions, unavailable setups, or missing recorded folders refuse creation.

## Session controls

Setup fields use the shared [select-only combobox contract](rail-and-navigation.md#keyboard-and-screen-reader-contract). Loading and unavailable metadata remain field statuses, never choices. Only open option rows mark CLI-reported defaults. Closed fields and setup summaries use concrete names.

Opening, cancelling, or accepting the selected row preserves saved launch values. Choosing a different default Model omits model and effort overrides. Choosing a different default Effort omits only effort. Live sessions send supported switch values.

Catalogs belong to agents. Selected and pending choices belong to sessions. Recorded turns settle pending choices. Effort choices follow the selected model. Both agents change model through the existing child. Claude effort commands that start turns wait for running work to finish.

Permission wording follows each agent. Codex presets map approval policy, approval reviewer, and sandbox policy. Without an Arc choice, Codex configuration and folder trust decide effective values. Unmatched presets show `Codex settings` with no checked row. New and handoffs without an Arc choice preselect `Approve for me`.

Codex auto-review can approve, deny, or forward unsafe actions. Other modes send surfaced requests to the reader. Thread and turn sandbox spellings differ. Preserve the wire adapter’s translation.

A failed newer turn without runtime facts retains the last model, effort, context, and next-turn estimate.

A stopped Codex turn without a model displays the session’s last reported model. That identity supplies no effort, context, or price. Newer reported models and existing selected or pending choices retain precedence.

The next-turn price follows the accepted model pick immediately. [Context evidence](accounting.md#context-evidence) owns pricing, cache eligibility, compaction, and unmeasured tool-input rules. The browser selects the supplied warm or cold face using its clock. Both faces share a grid cell sized for the longest face, so changes never move the text field.

Only the price is pressable. Its accessible name includes the surrounding sentence, whose duplicate nodes stay hidden from accessibility. On face changes, move an open popover and focus to the visible price. Exclude hidden prices from footer focus restoration. Detail retains the alternate cache estimate and conservative API list-price qualification.

Cache duration updates through the shared ticker without repainting or losing selection. Only duration carries the dotted affordance. Native titles name model lifetime without request timestamps. Durations use whole minutes with a two-minute minimum. Boundary bands cover shorter spans.

Draft setup comes only from its profile, ignoring session picks and per-agent permission choices. Drafts add Agent and omit context because they have no window. Changing a value marks the profile custom. Changing Agent resets Model and Effort and selects `Auto` for Claude or `Approve for me` for Codex. MCP reflects that draft’s servers.

Pending or successful first submissions block setup changes. Failed first submissions permit retry changes. The child uses the captured setup. Typing or draft-control changes retain a draft after selection changes. The launcher’s custom form alone does not retain an untouched draft.

## MCP controls

MCP controls appear only for reported configured servers. Opening a draft or returning to the panel retries a missing initial idle answer.

Opening Servers reuses a running Claude draft child and retains that child while pending servers settle and through first-prompt delivery. Drafts and recorded sessions keep separate readings. MCP rows retain action and checkbox roles. Arrows, Home, End, and typed names move focus. Tab closes and continues through controls. Escape returns focus to Servers.

Claude supports status, toggle, and reconnect. Codex supplies status only. Only `disabled` means off. Preserve unfamiliar states without treating them as disabled.

Claude persists some MCP changes only during orderly shutdown. Close child input before killing an unresponsive process. Status reads started before a toggle cannot overwrite its result.

Authentication and server configuration use no panel workflow. Authentication-required servers report their state without offering an unsupported action.

## Context detail

Hover or focus opens context detail. Clicking, Enter, or Space pins it. Tab reaches Measurement details and Compact. Escape or the expanded bar dismisses detail and restores bar focus. Outside presses and session changes also dismiss it.

Claude detail uses estimates from the selected connected child. Category meters require their sum to equal occupied tokens. Mismatches retain warnings and a percentage-only table. Accessible names and titles retain token counts and accounting capacity. Free space supplies Remaining. Compaction reserve stays separate.

Disconnected Claude sessions retain recorded figures and show “Send a message to see the context breakdown.” Failed requests show generic unavailable detail. [Context evidence](accounting.md#context-evidence) owns Codex estimates and unavailable states.

Inspection starts no child or model turn. Invalidation affects only that session and rejects obsolete replies. Refresh retains disclosure and selected text. Focus stays on surviving controls or falls back to Compact or the dialog. Pointer or focus inside retains detail. Positive categories with zero reported total show unavailable percentages.

## Project setup storage

Each host serializes project pins and recents together. Simultaneous windows can lose one same-project change. Different projects use separate keys. Other-window pins appear on the next pin change or refresh. Actions carry displayed project ownership. Recent-row pinning carries displayed values so shifted history cannot pin another setup.

Project identity uses the canonical common Git directory across checkouts, registered worktrees, and opened subdirectories. Non-Git folders use canonical folder paths. Failed identity reads retain successful identities or leave storage unavailable. Folderless windows have no reusable setup.

Initialization saves copied legacy pins and empty recents together. Existing entries, including invalid or empty entries, never import again. Legacy storage remains unchanged. Browser readiness retries loading and combines concurrent reads for one folder. Workspace changes start separate reads and reject obsolete results.

## Model resolution

Use `recordedChoice` for recorded models and applied defaults across controls, inherited setups, and price projection. Its identity matching handles windows, Bedrock prefixes, snapshots, aliases, and deployment suffixes without model-version rules. Keep ambiguous API identities unresolved. Several rows with one identity resolve to the visible model-menu row.

`defaultIdentity` projects applied defaults onto the same row without changing saved or wire values. Omitted choices use that row’s label and efforts. Window-added values such as `opus[1m]` resolve across controls, launching, and setup checks. Inheritance retains a recorded differing window. Per-model defaults and switch values still require exact resolution.

## Draft initialization

Register reader-started parents before the first selected-only refresh. It projects the selected row synchronously from held catalogs. Later persistence or focus messages do not rebuild parent projection.

## Catalogs and applied defaults

The first visible ready panel requests catalogs independently of history loading. Restored selections retain their owner request until the row arrives. MCP-only requests skip catalog children. Saved same-CLI-path catalogs remain pending until the first fresh answer. Pending catalogs keep stored setups startable. Loaded catalogs restore missing-value checks. Failed reads restore checks only without a saved catalog.

Profile changes retire distinct provisional children unless a child accepted its first prompt. Acceptance uses the agent and draft key and survives later save or adoption failures.

Key defaults by agent, working directory, and committed model value. Requests also carry the configuration revision. Windows folder comparisons ignore case. Saved readings remain drawn while one fresh read runs per key. Fresh answers replace both displayed and saved values, including unavailable answers. Invalidation retains visible values and makes the next lookup refresh.

Unobserved configuration changes, including environment changes, can leave saved readings stale. Until refresh answers, `(default)` marks the old default. Selecting it omits the override, so the CLI applies its actual default. [Configuration watches](development.md#configuration-watches) defines invalidation.

Claude metadata children omit effort overrides. Codex metadata uses app-server defaults, excluding TUI-only managed model defaults. Missing metadata leaves omitted launch values valid. Visible model rows combine aliases without changing raw pricing or attachment catalogs.
