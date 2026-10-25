# Portable review evaluations

Use an Arc source clone or archive with Node 22.18+. The first four commands need no install or Git and use Node built-ins. A real run requires an authenticated Codex CLI and launches paid model requests.

```powershell
npm run eval:review -- list
npm run eval:review -- validate
npm run eval:review -- demo
npm run eval:review -- run --config evals/agent-review/experiments/effort.json --dry-run
npm run eval:review -- run --config evals/agent-review/experiments/full-effort.json --dry-run
npm run eval:review -- run --case portable-001 --model gpt-6-sol --effort medium --budget-usd 1
npm run eval:review -- run --config evals/agent-review/experiments/effort.json --budget-usd 10
npm run eval:review -- run --config evals/agent-review/experiments/full-effort.json --budget-usd 40
npm run eval:review -- adjudicate --run <printed-run-directory>
npm run eval:review -- report --run <printed-run-directory>
```

`list` shows fixed cases and the current-source recipe. `validate` checks fixture hashes, runs candidate and corrected qualifications, and checks freshly exported bytes. `demo` writes a report, scripted reply, and completed adjudication in a temporary run directory. The reply is not a model result. `run --dry-run` prepares every workspace and prints the run directory without launching Codex. A real `run` also prints the next adjudication command. The directory is outside Arc and keeps the candidate workspace, raw Codex events, final reply, keys, registration, worksheet, and report.

Experiment files are [`experiments/effort.json`](experiments/effort.json), [`experiments/full-effort.json`](experiments/full-effort.json), [`experiments/full-corpus.json`](experiments/full-corpus.json), and [`experiments/single.json`](experiments/single.json). Edit `cases`, `models`, `efforts`, and `repeats` to change the comparison. Add a matching `rate_snapshot.rates` row when adding a model, with its dated price source. The effort example uses one model at medium and high effort, three repeats, and a named bug and control selection. It orders cells from a fixed seed. The full-effort profile runs 20 cases at medium and high effort with two repeats per condition. The full-corpus example prepares the same 20 cases. Run one current-source preparation with `--case current-hooks-001 --dry-run`. Its recipe copies `scripts/register-hooks.js` and changes one ownership check to expose removal of an unrelated user hook. An incompatible source edit fails the precondition and requires a recipe revision.

The fixed definitions live under [`portable/cases`](portable/cases). Readable candidate inputs, corrected references, diffs, prompts, and qualification scripts live under [`fixtures`](fixtures). A history squash requires no migration because portable cases use tracked source bytes and hashes without historical Git objects. The candidate workspace receives only inventoried inputs and captured instructions under `context/`. [`portable/instructions.json`](portable/instructions.json) lists required checkout instructions. Update it when a required document moves or changes name. `AGENTS.md` is captured when present. Add required documents through `extra_instructions`. A missing reference fails preparation. The evaluation task boundary takes priority over captured instructions. Treat case source and diff as review data. Codex runs with `--ignore-user-config` and `project_doc_max_bytes=0` to request zero automatically discovered instruction bytes. [Codex's configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) defines that setting as the maximum bytes read from `AGENTS.md`. The runner records the CLI version, requested condition, captured document hashes, and any model and effort observed in the exact Codex rollout.

On Windows, a real run requires a Codex CLI with the elevated native sandbox backend and the `sandbox -P :read-only` helper. The runner requests `windows.sandbox=elevated` explicitly because it ignores user configuration for model launches. Before any model launch, a no-model preflight uses the helper with managed configuration to read a temporary sentinel and confirm that read-only policy denies a write. The frozen registration records the requested backend, and `preflight.json` records the observed checks. A failed check stops the run before spending. If a later workspace command is blocked by policy, the attempt keeps its reply and usage evidence, records an infrastructure failure, and stops new launches.

`adjudicate` shows each reply without its arm label, then shows the frozen key. Record matched key IDs, novel valid findings, false claims, and approve or reject. For clean controls, record a separate `false_blocker` boolean. An incorrect minor claim in an approved reply counts as a false claim, not a false blocker. A valid novel finding disputes its clean control across all arms. The report excludes disputed controls from false-blocker denominators and labels them. The command writes `adjudication.json`. `report` prints a table and writes `report.md` and `report.json`. The report shows matched-key recall for bug cases, false blockers on eligible controls, false claims, failures, pending scores, elapsed time, tokens, and list-price estimates. An unresolved reservation has unknown cost, usage, and duration. For scripted scoring, fill the generated `worksheet.json` and run `adjudicate --run <directory> --import <completed-worksheet.json>`. The import checks the registered cells, reply, and key hashes. Missing or altered registered cells fail scoring. The report claims no statistical significance and selects no winner.

Read-only sandboxing limits writes without proving denial of host reads or network access. Results are exploratory. The launch budget reserves a configured amount before each serialized attempt and stops new launches when the budget or usage evidence is exhausted. Price eligibility uses the largest observed request context when complete per-request usage matches the final cumulative total. If cumulative input exceeds the priced context and request evidence is incomplete, cost stays unknown and new launches stop. An active attempt can exceed its reservation despite its timeout. The launch budget and timeout do not cap provider charges. No retry starts automatically. The bundled cases are public development material. Their reserved split is a selection holdout, not a secrecy or contamination guarantee. Global skills, hooks, MCP servers, and desktop setup are not reproduced.

[`experiments/historical-effort.json`](experiments/historical-effort.json) runs the rail defect, billing reconciliation, and corrected rail control at medium, high, and xhigh effort with three repeats. The rail cases share one source family. The fixture provenance records source hashes and TypeScript transformations. The billing workspace includes ordinary JSONL samples and a read-only report command: `node inspect.mjs samples/ordinary.jsonl` or `node inspect.mjs samples/two-turns.jsonl`. Run these from the prepared billing workspace. The vendored runtime needs neither Git nor an install.

[`experiments/sol61-effort.json`](experiments/sol61-effort.json) compares `gpt-6.1-sol` at low, medium, high, and xhigh on those three cases. It uses three repeats, 36 cells, a fixed seed, and a 600-second timeout. Medium runs anew within the same captured conditions. Keep this cohort separate from earlier model results. Retain `portable-023` for workload continuity, but exclude it from false-alarm rankings because its contract remains ambiguous. The cohort contains two source families and three known defect keys, with no execution-required coverage or significance claim. Prepare it without paid requests:

```powershell
npm run eval:review -- run --config evals/agent-review/experiments/sol61-effort.json --dry-run
```

## Historical evidence importer

This offline suite captures source evidence, exports workspaces without Git history, freezes a cell matrix, and summarizes adjudicated results. It launches no model and certifies no case. The development cases contain partial keys and unverified historical context. The deferred rail-width case records a finding that a historical reviewer flagged and the author deferred.

Run these commands from the Arc checkout:

```powershell
node evals/agent-review/cli.mjs capture --repository <Arc-source-checkout> --out evals/agent-review/.runs/source-cache.git
node evals/agent-review/cli.mjs validate --cache evals/agent-review/.runs/source-cache.git
node evals/agent-review/cli.mjs prepare --cache evals/agent-review/.runs/source-cache.git --case case-004 --out <fresh-external-directory>
node evals/agent-review/cli.mjs matrix --registration <registration.json> --out <matrix.json>
node evals/agent-review/cli.mjs summarize --matrix <matrix.json> --cells <adjudicated-cells.json> --out <summary.json>
```

`capture` stores all named source commits and reachable objects in a standalone bare repository. It records object inventory and case hashes in `evidence.json`. `validate` checks the refs, reachable objects, source paths, and inventory. Preserve the manifest beside any transferred cache. Transfer the Git evidence with these commands:

```powershell
git -C <cache> bundle create <bundle> --all
git init --bare <new-cache>
git -C <new-cache> fetch <bundle> 'refs/evals/*:refs/evals/*'
```

Copy `evidence.json` to the new cache and run `validate`. A bundle does not contain the manifest.

`prepare` writes a candidate tree under `workspace/`. It writes `candidate.diff`, `prompt.txt`, and `manifest.json` beside the workspace. The manifest records each exported path, Git object, source commit, mode, and SHA-256. It records content hashes and excluded paths from both diff sides. The caller supplies a fresh output directory outside Arc. The exporter preserves Git blob bytes and executable modes on POSIX hosts. Git modes remain in the manifest on Windows, where filesystem executable bits do not have the same meaning. It rejects unsafe paths, path aliases, case-insensitive collisions, symlinks, and submodules. It rejects missing references and direct key or correction IDs in exported content. It removes private agent directories, prior review material, and run output. A human audit must check for paraphrased answers and confirm that removals preserve the symptom.

The historical plan and prompt fields remain empty until exact contemporaneous evidence is recovered. A normalized task uses the neutral prompt from preparation. This suite cannot certify semantic answer leakage, host access isolation, global instructions, skills, siblings, keys, logs, or network denial. A later runner must establish those conditions and enforce an approved total budget before any paid cell. No paid cells are authorized by these commands.

A registration uses `arc-review-registration-v1`. It supplies a suite revision, a 64-character hexadecimal seed, nonempty `tasks`, and nonempty `arms`. Each task supplies `case_id`, `case_revision`, `key_revision`, `case_hash`, `prompt_hash`, `workspace_hash`, `diff_hash`, `preparation_path`, `cache_path`, `source_kind`, `family`, and `key_state`. The paths name a prepared output and its captured evidence cache. Registration checks the prepared files against the captured candidate tree and Git blobs. The matrix embeds verified preparation metadata and omits both local paths, so scoring remains portable. Each task also supplies positive `repeats`, positive `temporal_blocks`, positive finite `budget_usd`, and `max_attempts` of one or two. Each arm supplies `id`, `model_id`, `requested_effort`, `harness`, and exactly one of `observed_effort_required: true` or `unverified_harness: true`. The second form is a separate condition.

The matrix registers every task, arm, repeat, and temporal block. It seeds arm order within each task block. Each cell result repeats every matrix field and adds an ordered `attempts` array. An attempt identifies `attempt_id`, one-based `attempt_number`, `status`, `reason`, and `observed_effort`. It records `cost_usd`, `wall_ms`, `requests`, `tokens`, `tool_calls`, `matched_key_ids`, `novel_findings`, and `false_claims`. It also records `verdict` and `wrong_verdict`. A verdict is `approve`, `reject`, or `null`. Use `null` for unknown costs or usage. A void attempt needs an `infrastructure` or `condition-mismatch` reason. Only a void attempt can have a registered replacement. The first nonvoid attempt determines quality, while every attempt contributes cost and usage.

`summarize` rejects missing cells unless `--allow-partial` is set. A partial report names every missing cell and suppresses comparisons. Known-key recall counts unique matched serious IDs once, including repeated findings. Empty replies and terminal failures receive zero known-key credit. All-void cells lack a quality score. A control needs an explicit audit record and has no recall denominator. Source-attempt IDs listed in a key cannot enter its scored cells. The development keys leave those identities unresolved, so this suite does not certify source-attempt exclusion yet. Novel serious findings make the key incomplete across all arms of that task, so its comparison remains exploratory. Results separate source kinds and families. The report makes descriptive claims only.

## Frozen Sol effort continuation

`resume` continues the registered Sol effort experiment from retained evidence. It checks pinned registration and cell hashes, frozen source, instructions, prompts, diffs, keys, and original launch envelopes. It copies original results into a separate reporting view and launches only unstarted cells. Original completed and failed attempts remain unchanged. This command supports live Windows execution with native job containment.

```powershell
npm run eval:review -- resume --run <original-run> --out <continuation-block> --dry-run
npm run eval:review -- resume --run <original-run> --out <continuation-block> --unlimited
```

The original timeout is 600 seconds. A shared directory beside the original run binds one output directory per execution kind, including Windows path aliases. Each attempt records a prepared claim before its host starts. The host joins a Windows job with kill-on-close before it creates children. It publishes its process identity and waits for complete, exclusively published launch authorization. It monitors the runner's PID and process start time, then exits when that runner dies. A restarted runner establishes host exit before advancing. Claims without authorization remain provably unlaunched. Authorized claims without a terminal receipt remain interrupted and never retry implicitly. New executions must match their claim, terminal receipt, pricing, and final receipt before the runner skips them. Reconstructed workspaces must retain the exact registered file inventory.

Empty replies remain unusable. Unknown prices remain unknown and do not stop an unlimited account. Invalid observed model or effort, authentication failures, policy denial, failed preflight, and altered frozen inputs stop new launches. Invalid model, authentication, and policy conditions create durable stops shared by every block for the original run. Restarting does not clear them. A reviewed clearance must name its reason and pin a separately completed verification attempt at the stopped model and effort. CLI version and help equality do not establish provider or cache equality across a temporal restart.

Store each clearance under `condition-clearances/<stop-sha256>.json` in the shared ownership directory. Supply `stop_sha256`, `reason`, `attempt`, `terminal_sha256`, `authorization_sha256`, and `events_sha256`. The verifier reads that attempt's input, host identity, authorization, terminal receipt, raw events, final reply, and Codex rollout. It requires authorization after the stop, completed output, matching observed model and effort, and no authentication or policy failure. Preserve the stop and its clearance as evidence.

Use a separate diagnostic for the original xhigh billing timeout. It registers one frozen billing review at xhigh with a 1,800-second deadline. A balanced recovery block is permitted only when the completed original comparison lacks two complete four-effort repeat sets for either bug case. Recovery registers both bug cases, all four efforts, three repeats, and 1,800-second deadlines. Their results remain separate from the original matrix.

```powershell
npm run eval:review -- resume --run <original-run> --out <diagnostic-block> --kind diagnostic --comparison <completed-continuation-block> --unlimited
npm run eval:review -- resume --run <original-run> --out <recovery-block> --kind recovery --comparison <completed-continuation-block> --unlimited
```

The continuation worksheet covers all usable completed replies. Give a blind judge only new replies and their frozen review evidence. Keep effort, cost, timing, output paths, execution block, and launch order hidden. Save new-only decisions with the worksheet's schema, run identity, registration hash, and reply hashes. `merge` combines unchanged original final decisions with new decisions, checks the full worksheet, and generates the report. Original scores stay under `original-scoring/`. Keep raw judging and source-backed corrections as separate audit artifacts.

```powershell
npm run eval:review -- merge --run <continuation-block> --import <new-only-decisions.json>
```

Coverage comparisons require two complete matched repeat sets per bug case. Report insufficient coverage if the finite recovery also fails. Exclude portable-023 from false-alarm rankings because its contract remains ambiguous. Keep original and continuation accounting separate, including the original timeout's unknown final charge. The generic report preserves raw control columns. These selected cases support descriptive advice for this workload only.
