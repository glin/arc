# Performance diagnostics

## Performance capture

### System capture

Start performance investigations with a bounded system capture. Save it before reloading the editor or restarting Explorer. Record the scenario and active test runners. Use the same collector and comparable workloads for comparisons.

For a Windows capture, run:

```powershell
.\scripts\capture-panel-diagnostics.ps1 -Scenario "<scenario>" -Samples 8 -SampleIntervalSeconds 1
```

For a Windows, Linux, or macOS capture, run:

```bash
node scripts/capture-panel-diagnostics.js --scenario "<scenario>" --samples 8 --sample-interval-seconds 1
```

Keep active windows and sessions running during script captures.

Collect additional snapshots or profiles only for an explicit request or a question the system capture cannot answer.

`scripts/capture-panel-diagnostics.js` owns output files and manifest fields. The default output directory sits under the system temporary directory. Pass `--output-directory <path>` to retain a capture inside its investigation plan. The directory must not already exist. These local files can contain sensitive command-line arguments and paths. Review them before sharing.

Windows delegates to `scripts/capture-panel-diagnostics.ps1`. Its output option is `-OutputDirectory`. The quota snapshot uses the Windows default of 10000 only when the registry value is absent. An invalid counter sample retains its status and has no value. Do not sum process counters to infer whole-machine CPU utilization.

GDI and USER values count objects owned by a process. Positive growth alone does not establish a leak. Restarting Explorer reloads the taskbar and File Explorer windows but does not identify the allocation source.

Linux and macOS use Node.js, `ps`, and platform memory counters without PowerShell. CPU utilization comes from system CPU-time deltas and remains unavailable without a valid interval. Linux commitment estimates have separate names because their overcommit rules differ from Windows commitment. Free memory and available memory remain separate measurements. macOS does not infer available memory from free pages.

Non-Windows manifests mark Windows diagnostics as `not-applicable`. Process deltas require the same PID and start time. Unix `ps` start times have one-second precision, so a PID reused within that second cannot be distinguished.

### Host health evidence

Sparse health recording runs with `arc.diagnostics.log` disabled. Open the current file through `arc.openDiagnosticsLog` when no detailed log exists. `arc.savePerformanceDiagnostics` includes provider identity and the current I/O failure status without a local health file path. Preserve the files before restarting the editor.

Find retained activations on Windows:

```powershell
Get-ChildItem "$env:USERPROFILE/.arc/logs/health-*" | Sort-Object LastWriteTime
```

On Linux and macOS:

```bash
ls -lt ~/.arc/logs/health-*
```

Use `$env:ARC_HOME/logs` or `$ARC_HOME/logs` when `ARC_HOME` is set. Each activation has a `health-<provider-id>.json` snapshot and up to two JSONL event segments. The previous segment ends in `.previous.jsonl`. An interrupted atomic replacement leaves a `.json.next` temporary file. The complete `.json` remains the accepted snapshot.

Match the PID to the Extension Host and `ARC_HOME/hosts` registry. Provider identity distinguishes activations within one process. Workspace hashes identify the JSON workspace-folder array. `HostHealth` in `extension/src/diagnosticslog.ts` owns the schema. Watch builds report `watch`, and uncompiled hosts report `missing`. `diskChanged` compares only bundle size and modification time. Replacements preserving both escape it.

RSS covers the whole host, including other extensions and workers. Heap and external memory cover the sampling JavaScript thread. Delay measures heartbeat delivery after a five-second interval. Additional settlement samples carry unavailable delay and preserve the heartbeat clock. A large delay establishes host scheduling delay without attributing its cause. An abrupt exit prevents a final sample. Unknown termination also covers forced shutdown and failed diagnostic I/O. Only successful provider disposal records clean termination.

Pending worker reads keep `enteredAfterMs` null until acknowledged. Health and startup records retain four recent window reads. Host and worker durations use separate monotonic clock origins. Never compare their absolute timestamps. `enterMs` covers receipt through revision checking to read start. `readMs` is the read's wall interval. `replyMs` runs from the last preceding stage to before the reply post. Interleaving counters establish other activity during the read. They cannot allocate its wall time. Use a worker CPU profile for that question.

Compare attached, ready, and retained-tab counts. Editors without the tab API report retained count unavailable. Retained tabs without attachments lack provider ownership. Attached tabs without readiness have incomplete browser startup. A progressing host with stopped acknowledgements lacks browser replies. Acknowledgement confirms message handling alone. It establishes neither paint nor action completion. Disconnected retained tabs provide no browser evidence to replacement providers.

Read lifecycle events beside each snapshot. `serializer` includes restoration and prompt recovery before adoption. Selection and Send settlements marked pending do not establish refresh completion or agent acceptance. `extension/src/panelhost.ts` owns lifecycle event sites and prompt retention.

`refresh`, `sessionIndex`, and `hostSave` have no `begin` event. Returned outcomes appear only at 100 ms or more. Failed or rejected host saves appear at any duration. Preferences and workspace resets are host saves. Persistently high `work.hostSaves` with an old oldest entry identifies a save backlog. Slow storage or publication to open panels causes that backlog.

Health retention is bounded:

| Evidence                                   | Bound                                                       |
| ------------------------------------------ | ----------------------------------------------------------- |
| Activations                                | Twenty, subject to concurrent hosts recreating pruned files |
| Snapshot and temporary snapshot            | 16 KiB each                                                 |
| Event segments                             | Two, 64 KiB each                                            |
| Recent samples                             | Twelve                                                      |
| Active work entries                        | Thirty-two                                                  |
| Panel observations and recent settlements  | Sixteen each                                                |
| Event rate                                 | Eight lines per second                                      |
| Extra snapshot after suppressed settlement | At most once per second                                     |
| Quiet-host snapshot cadence                | Five seconds                                                |

Counters retain totals beyond recent history and report suppressed events or refused in-flight entries. Only settlements still in bounded history survive later snapshots. Files exclude prompts, session identifiers, file contents, and arbitrary error messages. Missing files establish unavailable evidence. Diagnostic failures leave product actions unchanged, retry each cadence, and retain failure counters. Observation errors leave counts unavailable. Live capture reports current failure even if the durable snapshot still says active. Retention races do not stop recording. Synchronous writes add storage-dependent overhead without power-loss durability guarantees.

### Extension Host and webview profiles

The owner records the following profiles in their own window. Reload the VS Code window before recording an extension profile. Run `Developer: Show Running Extensions`, start the Extension Host profile from that editor, stop it, and save the profile.

Use `Developer: Open Webview Developer Tools` and record the Performance tab for session list scrolling, typing, and paint. Capture the Extension Host and webview profiles for the same scenario. Capture matching session list-open and session list-closed scenarios. Record the commit, dirty state, pin count, and spend-ledger state beside each capture.

`Developer: Profile Local Agent Host Process` profiles a different process. Do not use it as an Extension Host profile.

An Extension Host profile samples one JavaScript thread. A busy webview or worker can leave that profile mostly idle. An idle host profile cannot identify the process causing high CPU use. Read the startup milestones before the profiles. `arc.savePerformanceDiagnostics` writes them. `firstCard` follows the first turn card drawn and acknowledged by the browser. A large gap after `railReady` directs investigation toward selected-session reading or rendering. The two milestones alone do not identify which one delayed the card. On Windows the extension host runs as `Code.exe --utility-sub-type=node.mojom.NodeService`, and the workbench and each webview run as `Code.exe --type=renderer`.

Capture without a save dialog through the command API:

```js
await vscode.commands.executeCommand('arc.savePerformanceDiagnostics', file);
```

The command returns the written path or `null` after cancellation or failure. Failure appears in the window and as `performanceCaptureFailed`, even with detailed logging off. An explicit path overrides `ARC_PERF_OUT_DIR`. Relative paths resolve against the open folder and fail without one. `extension/src/performancediagnostics.ts` owns destination selection.

Read `panelAdopted` before comparing startups. `created` means command-opened, `serializer` means restored, and `serializer-replaced` means stale stored options required replacement. `panelRevealed` retains its adoption origin. These records require `arc.diagnostics.log`. `revivePanel` and `adoptPanel` in `extension/src/panelhost.ts` own restoration and prompt-recovery failure handling.

### Startup measurement

Measure startup against frozen inputs with `extension/scripts/panel-startup-measure/measure.ts`. Run it from `extension`:

```bash
npx tsx scripts/panel-startup-measure/measure.ts --fixture <manifest.json> --commit <ref>
```

The manifest names `workspace`, `projects`, `codex`, `store`, and `state` paths beneath its own directory. State must name the selected session through `showing`. `expectedSelection` supplies its `session`, newest turn `key`, `prompt`, and `summary` text. Missing expectations leave the result incomplete. Freeze transcript roots, cache inputs, and selected session before comparison. The workspace must resolve no Git repository. Inputs containing directory links or external transcript paths fail validation. The runner reads no live editor database. It retains only navigation and filtering state and removes pending agent actions.

Every run creates unique profile, extensions, Arc store, state, and build directories. The browser lane lock serializes editor measurements with browser tests. `--commit` selects the source revision. Without it, the runner builds HEAD in an isolated checkout. Dependencies are linked without installing. The measured editor blocks agent connections before activation and opens Arc through the created-panel route. Older baselines receive the same measurement-only launch block and state seed. This overlay is recorded with the artifact identity.

`seedProfile` in the measurement runner owns diagnostic settings and first-run suppression.

The runner records owned paths, frozen input hashes, artifact hash, and process identities. `result.json` retains completion, observations, clocks, and the selected identity. It stops only processes belonging to its unique profile. `--timeout <seconds>` bounds the wait for all startup milestones and defaults to 30 seconds. Completion received after the deadline remains incomplete. `completeRender` acknowledges background session-list completion after discovery and metadata settle. Accepted browser observations must show usable session-list rows and the selected turn. Raw response identity stays separate from rendered response text or the folded card headline. Missing milestones or observations produce an incomplete result and nonzero exit. Shell and empty-list acknowledgments do not establish usable content.

Add `--selection` to collect session-switching evidence through the isolated editor's local CDP endpoint. `extension/scripts/panel-startup-measure/selection.ts` owns overlay events and driver scenarios. Ordinary scenarios wait for accepted completed content and its corresponding frame. An observed pending request permits an interruption attempt. Final identified window events and conservative clock bounds determine whether that request remained pending at the browser click. Ambiguous overlap remains unavailable. Browser events keep native monotonic timestamps. Clock exchanges bound browser-to-host and worker-to-host offsets by transport intervals.

Selection evidence lives in `selection.json` and `selection-trace-*.jsonl` under the printed run directory. The overlay copies message payloads and performs synchronous trace writes, so its timings include recording overhead. File traces retain descriptor ownership through successful open and close, numeric read counts, and encoded string byte lengths. Asynchronous file operations and compositor presentation remain unavailable. Missing stages, unmatched request chains, and inconsistent clock identities remain incomplete. Explicit cancellation supplies a terminal status without requiring a successful reply. Unobserved cached work remains unavailable. Untagged browser messages retain absent click ownership. The runner returns an incomplete result until independent review qualifies the evidence and representative frozen inputs. Synthetic inputs establish transport and correlation behavior, without establishing live workspace latency.

Add `--response` to capture one synthetic live response becoming a recorded rich response. The runner copies the fixture's Codex corpus before activation. The overlay requires agent blocking and appends a completed turn beyond the newest four MiB of the copied rollout. `measureResponse` in `extension/scripts/panel-startup-measure/selection.ts` owns interaction checks and artifacts. These captures include the same recording overhead and timing limits as selection captures.

`--keep` retains the build checkout. Other run resources remain available for inspection. A cleanup refusal ends the run without a retry. `ARC_MEASURE_EDITOR` selects a VS Code install directory. Compare repeated runs with identical inputs, settings, selection, and imports. Shared machine workload and operating-system disk cache remain measurement limits.

### Session list publication measurement

Measure the session list publication path without an editor:

```bash
npx tsx scripts/rail-publication-measure.ts [rows] [running] [ticks] [tickMs]
```

Run it from `extension`. It builds a session list of `rows` sessions with `running` running sessions, then runs `ticks` host update cycles `tickMs` simulated milliseconds apart. Each cycle changes one running session, runs the input gate, builds the payload, encodes the row delta for one panel, and measures the serialized bytes. The report counts gate passes, snapshot and delta posts with their bytes, rows carried, and bytes per simulated minute. Counts and bytes are exact. Wall times per step depend on the machine and order the steps only.

## Diagnostic implementation

The saved snapshot keeps these counters beside the message and refresh tables. `watcherDecisions` counts targeted and broad watcher decisions, and `broadReasons` counts why each broad decision walked: `missingFilename`, `createOrRename`, `requested`, `activityFallbackNoFile`, `noPaths`, `unknownPath`, or `unspecified`. `rowPosts` splits render and session list posts into `whole` and `delta`, with bytes for each, and `wholeReasons` counts why a panel received a snapshot: `first`, a `reset:` cause (`ready`, `unready`, `gap`, `unaccepted`, `failed`, `unkeyedRows` or `repeatedIds`), a `globalMoved:` field name, `repeatedIds`, or `unkeyedRows`. A `reset:unready` cause is never reported, because the panel's `ready` message resets the sender again before any post. `rowsGapCount` counts panel requests for a snapshot after a lost delta. `work` counts named host operations: `catalogWalk` is one complete catalog walk, and a `walk:` name counts each refresh that does not reuse the held catalog, with its cause (`requested`, `noCatalog`, `scopeMoved`, `noSelection`, `selectionMissing`, `selectionFileMissing` or `selectionReplaced`). `childVersionStat` and `humanPromptStat` are file checks. Readers of one child file in one synchronous host run share one `childVersionStat` check. `humanPromptSettled` counts a session admitted from its complete scan without a file check, `dispatchedCostsPost`, `childExpiryCosts` and `liveOpenChildren` are child and cost derivations, and `railSkippedRevision`, `railSkippedInputs` and `railPayloadBuilt` record how each session list update ended.

`discoveryObservation` keeps the last accepted request's cumulative charges and receipt age through failure. Its charges overlap settled totals after completion. Never add them. Invalid or obsolete acknowledgements replace neither the checkpoint nor this observation. Worker memory comes from completed quantum boundaries with thread, request, and host-receipt age. New workers have no memory observation. Worker failures retain bounded identities and pending work. Deliberate cancellation and disposal report no crash. These snapshots identify no allocation sites.

Read delegated Codex spend counters in `extension/src/codex.ts`. Discovery observations retain per-request counters, and settled totals sum them across replies.

[Timeline checks](testing.md#timeline-checks) use production derivation with later timestamped records removed and write times clamped. Current filesystem timestamps cannot reconstruct historical writes. Missing background identity, work timestamps, or complete evidence yields unknown. Incomplete admitted sources remain counted without readable turns. Raw parent process ends exempt preceding child work from resumed-running checks. Later child work remains checked. Figure and session-list comparisons use one derivation and establish no independent truth. Codex, dispatched rows, and commit counts are outside this sweep.

`StartupHistory` in `extension/src/diagnosticslog.ts` owns history under the Arc home's `startup` directory. Read host and panel clocks separately. Stages stop after background metadata completes. Missing selected text remains unavailable. Memory covers the whole Extension Host. Sampled startup maximum differs from process-lifetime maximum. Periodic sampling stops at completion or the first tick with sixty or more samples. Startup events also take samples. History keeps twenty prior matching files plus the current host file, subject to concurrent writers and deletion failures. Project cost hydration runs separately.

`readBytes` already includes transcript and receipt-relationship bytes. `receiptBytes` and `revalidationBytes` are subtotals of it. Do not add them again. `revalidationBytes` counts the bytes that re-hash a transcript prefix that an earlier scan accepted, before the scan reads any new bytes. Parent checks, subagent head reads, and dispatched-spend rereads have separate counts and wall times. JSON sizes are content proxies available only with detailed logging.

Measurement cleanup accepts only its registered, unlocked detached checkout. It requires a regular `.git` marker and an exact registration backlink, and refuses nested checkouts or filesystem crossings. It unlinks symbolic links and Windows junctions without traversing them. Registration is removed only after checkout removal. Directory identity checks do not sandbox concurrent replacement. `extension/scripts/panel-startup-measure/cleanup.ts` owns removal.

Node file readers invoke wrapped descriptor operations in the selection overlay. Never sum nested file traces as independent bytes. Shipping bundles contain no selection trace module.

Loading and repository-scope diagnostics run even with `arc.diagnostics.log` off. Match events by scope hash. They distinguish shown or hidden lines, held or released scope, withheld background work, blocking reasons, and Git-scope decisions. Changed reasons emit once, with intervening repeats counted. Line changes, withheld work, blocking reasons, and scope decisions have separate budgets. Each budget's final line carries `limitReached`. `panelhost.ts` owns event fields and admission.
