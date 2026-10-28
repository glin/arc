# Standalone sessions

[CLI launch options](cli.md#standalone-launches) owns command usage. [`cli/src/standalone.ts`](../cli/src/standalone.ts) owns process observation and capture. [`dispatchreceipts.ts`](../extension/src/dispatchreceipts.ts) owns receipt validation and publication.

## Explicit service-tier checks

An explicit Codex tier starts a read-only ephemeral app-server check before receipt reservation or worker launch. It uses the worker executable, environment, working directory, and model. Opening has a 15-second deadline. Cleanup closes input, requests termination after the exit grace period, and awaits exit on every outcome. The check sends no model turn. A successful check establishes launch-time capability and accepted normalization, not future account access. Exec and attended launches receive the canonical `service_tier` configuration override. Omitted tiers skip this check.

## Link a launched session

Arc links direct `claude --bg` and `claude -p --output-format json` launches from IDs in parent Bash results. Fresh `codex exec --json` launches require their paired stdout `thread.started` event. Claude and Codex parents support Codex launches and wrapper receipts.

Wrappers opt in with a standalone `--arc-dispatch` argument:

```bash
python review.py --arc-dispatch task.md
```

Print one unquoted stdout receipt per launch, after framing receipt-shaped worker text:

```text
ARC_DISPATCH_SESSION={"agent":"claude","session_id":"4f4bf298-958f-4751-8782-d8688ff808a6","name":"Review branch"}
ARC_DISPATCH_SESSION={"agent":"codex","session_id":"aaaaaaaa-1111-1111-1111-111111111111","name":"Review branch"}
```

`name` is optional. Add `"owned":true` for reader-requested work. No other `owned` value qualifies. Codex requires a full UUID. Claude accepts a full UUID or eight hexadecimal characters from background launch. Resolve within the named provider's current project. Detached wrappers must capture identity before printing.

Reject malformed, oversized, repeated, and ambiguous receipts. Direct Codex links require fresh launch and exactly one top-level stdout start event. Resumes, nested or quoted events, mixed launch modes, and stderr events establish no link.

## Standalone observation contracts

Identity comes from provider frames or launch-bound Claude registry entries. Claude print also accepts a new native user record matching its session hint, physical directory, and submitted prompt.

Keep native identity separate from relationship readiness. Receipts retain accepted source identity, pinned directory, physical cwd, opening length, and digest. Unknown paths require a launch-private binary pathname-digest set and immutable bounded manifest. Preparation failure preserves ordinary launch and output observation, with relationship evidence unavailable. Recovery never reconstructs the prelaunch set or replenishes its source allowance. A separate binding retains root witness identity.

Relationship verification requires an existing launch cwd that resolves to the saved physical cwd. Shared cache entries retain successful verification across cwd removal. Each entry binds the exact receipt, binding witnesses, and their physical identities. Every read rechecks those files, scoped session identities, and the original provider opening. Changed or redirected evidence rejects the link. A missing cwd without retained verification establishes no link. Concurrent checkpoints preserve an existing entry when its verification matches. Discovery prunes cache entries when their launch folders no longer exist. Removing the cache discards retained verification.

Source observation and continuity share work allowance, cancellation, and deadline. Check stable Codex and background-Claude identities once during framing. Revalidate at publication against one coherent source revision. Source changes restart validation within the original cumulative allowance and deadline. Missing original receipt evidence cancels remaining source work. Preexisting, redirected, replaced, and conflicting sources cannot qualify startup evidence. Observed replacement stays refused across observations. Unsettled sources leave reports pending. Final stdout reports require accepted binding. Ready background baselines wait for source readiness.

### Process release and management

Foreground native endings publish after one source check. Pending checks continue in the same supervisor within its deadline. Native completion sets `released: true` and `phase: "witness-pending"` on that monitor owner. Live or uncertain pending owners block acquisition until settlement. Dedicated unattended supervisors leave cwd before native release. Manual, attended, and library observations retain caller cwd.

Resolve explicit configuration selectors against launch cwd before admission. Absent Claude selectors stay absent, while receipts keep absolute transcript roots. Without selector evidence, Claude background launches retain saved reports but refuse native management, registry recovery, and capture. Logs, attach, and stop use the immutable background binding's original executable, cwd, and nonsecret selectors. A background job ID grants only that launch's management, without transcript identity or process termination authority. Registry disappearance supplies neither exit nor success evidence. The supervisor, output producer, and provider that Arc spawns with the standalone environment never receive `ARC_WINDOW` or the caller's `ARC_EDITOR_EXECUTABLE`. They receive the executable of the CLI process that starts them as `ARC_EDITOR_EXECUTABLE`. On Windows that value uses forward slashes. A private launcher on the launch PATH then runs `arc`.

Foreground process identity uses Windows creation and command data, Linux boot identity and start ticks, or macOS start and command data. Unavailable identity stays null. Changed commands do not prove changed process lifetime. Shell and Codex runtime launchers keep separate observation identities without native worker handoff. Background launcher identity supplies no worker ownership. Deadlines preserve captured exit evidence and otherwise retain unknown worker exit. Unavailable process lookup permits retry.

### Receipts and reports

Reserve private directories under `${ARC_HOME:-~/.arc}/dispatch` before spawning. Bound complete serialized receipts before reservation. Retain activation, requester, policy, prompt digest, completion route, and native argument/command-line digests. Bind prepared file identity before publishing accepted native turn identity. Missing root witnesses recover only matching binding bytes and identity. Observation admission checks complete saved bytes and status metadata. Retry transient publication replacement errors only within the finite deadline.

Immutable events retain private Markdown report paths and digests. Aliases supply no authoritative bytes. Refresh reads launch-private reports through retained physical identity. Claims and dispositions bind exact events. Receipts supply no usage or billing evidence. Relationship discovery retains reader ownership and original-source cost attribution. [`run.ts`](../cli/src/run.ts) owns dispatch-marker output, separate from worker output.

Saved response reads reuse provider reducers and bounded forward recovery through the accepted scoped catalog. Keep complete raw JSON text through 49 MiB before metadata reduction. Each source retains at most 512 MiB of conservative payload charge. Retain at most 32 sources. Frozen UTF-8 reports have an independent eight MiB limit. Claude agreement requires complete final text and message identity. Codex requires exact native turn identity. Missing evidence stays pending. Receipt errors preserve observations for retry without changing accepted delivery.

Hosted waits end at channel deadline or disconnect without changing workers. Event indexes have bounded segments without a total launch or event-count limit. Status omits disposition text and native ending evidence. Exact-event reads retain both. `DispatchReceipts.status` owns projection and page sizing.

Immutable write-lock successors serialize writes and dead-owner recovery. Successor and release files preserve ownership history. Live or uncertain owners retain locks. Windows refuses to replace a launch file while a reader holds it open. Launch-folder writes retry transient rename failures. Outcome publication retries under its acquired write lock. Identity checks detect observed replacement and redirection, without protecting concurrent metadata-preserving rewrites.

### Output capture

Detached providers write inherited files independently of supervisors and editors. Private stdout and stderr retain all output without a total size limit. Keep stdout, stderr, combined diagnostics, native Claude logs, and frozen responses distinct. Requested aliases remain separate from result observation.

Claude native capture holds an exclusive output claim and drains bounded slices from durable positions. Native terminal evidence ends capture after remaining bytes drain. Exhausted drains retain positions and private output for recovery. Capture checkpoints keep private positions and alias physical identities. A separate receipt lock reloads committed positions before append. Preserve another launch's alias. Without an alias witness, resume private output only.

Requested print logs use a separate capture process, forwarding provider PID and close events to the finite supervisor. `output-owner.json` retains ownership, state, and source failures. Alias and receipt-lock contention share a fixed drain deadline after close. `produceStandaloneOutput` owns flush retries and drain allowances. Source failure ends capture while inherited provider files remain.

`FrameStream` and `logChunks` own frame and read-chunk limits. Versioned checkpoints keep completed frames, bounded pending bytes, and file identity. Recognized versions check device, inode, and minimum size before restoring positions. Missing, replaced, or truncated output supplies no new report. These checks prove neither prefix integrity nor historical truncate-and-regrow detection. Older versions remain readable. Unknown versions restart from original output.

Checkpoints encode at most one 49 MiB pending frame as base64. JSON allowance also covers an eight MiB report and retained native message identities. Serialization and parsing have no hard latency bound. Appends share one cumulative allowance and deadline. Snapshot EOF alone does not establish work exhaustion.

### Attended launches and refusal

Attended Codex uses interactive arguments and inherited terminal I/O. Its exit supplies no final response evidence. Writable attended Claude attaches only after background binding. Terminal failure retains the launch and result. Terminal scripts carry the selected receipt root and nonsecret selectors into existing terminal environments.

Claude background launch refuses untrusted working folders, including new folders within trusted ones. Codex exec refuses untrusted folders outside Git. Publish recognized refusal as failed only with nonzero exit, no signal, blank stdout, and complete reads of both logs. Growth during reading makes a log incomplete. Resume retains recognized refusals without rereading logs, and preserves saved provider messages when logs become unreadable. Other endings without acknowledgment or native turn keep their outcome and add the first stderr line to the reason.

Standalone callbacks require proven daemon parent authority and remain unavailable. Use `cli/test/run.test.ts` and `dispatchreceipts.test.ts` for identity, replacement, observation, and capture checks.
