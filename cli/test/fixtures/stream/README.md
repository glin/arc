# Synthetic Claude stream corpus

`generate.mjs` writes every stream file and its expected JSON. No input contains a prompt, path, tool argument, tool result, or captured session data. Expected files use the complete `parent`, `children`, `combined`, and `run` sections of the `arc cost --json` contract. The generator uses the fixed rates below and checks each total against the hand-calculated value. The audit compares only listed keys.

`clientCostUsd` is null for a scope when one recorded `modelUsage` cost spans the parent and child. `expiryReturns`, `returnInputTokens`, and `returnInputUsd` are null when the stream has no visible turn boundaries. A visible turn with no expiry gives zero.

The rates below were read from `extension/src/pricing.ts` on 2026-09-25. Dollars are per million tokens. Opus 5.5 uses $4 uncached input, $5 five-minute writes, $8 one-hour writes, $0.20 cache reads, and $20 output. Sonnet 5 uses $2 uncached input and $10 output. A regional Bedrock Claude profile multiplies the Opus estimate by 1.1. A global profile uses 1.0. Claude CLI's `modelUsage[*].costUSD` remains the recorded list-price cost in both cases.

| Fixture | Hand calculation |
| --- | --- |
| `one-request` | Input `100 × 4 / 1m = $0.0004`. Output `20 × 20 / 1m = $0.0004`. Total `$0.0008`. |
| `five-requests` | Input `10 × 4 / 1m = $0.00004`. Write `50,000 × 5 / 1m = $0.25`. Read `329,000 × 0.20 / 1m = $0.0658`. Output `2,800 × 20 / 1m = $0.056`. Total `$0.37184`. The output includes `1,600` thinking tokens. The cache-read share is `329,000 / 379,010`. |
| `five-requests-jsonl` | The same requests and `$0.37184` total use newline-delimited JSON. |
| `repeated-chunks` | Two records share one message id. One `100`-input, `20`-output request costs `$0.0008`. |
| `last-result` | The request costs `$0.0008`. The last result records two turns, `2,000` ms, and `$0.0008`. |
| `unknown-model` | The Opus request costs `$0.0008`. The unknown model has no rate, so the estimated combined cost is `null`. Both requests use `200` input and `40` output tokens together. |
| `bedrock-regional` | The canonical assistant model has one recorded regional profile. Its list cost is `1,000 × 4 / 1m + 200 × 20 / 1m = $0.008`. The estimated profile cost is `$0.0088`. |
| `bedrock-global` | The canonical assistant model has one recorded global profile. Its list and estimated costs are `$0.008`. |
| `bedrock-ambiguous` | Two canonical requests cost `$0.016` at list price. Two recorded profiles cannot identify which request used which profile, so the estimated cost is `null`. |
| `one-hour-write` | `1,000 × 8 / 1m = $0.008`. |
| `expired-cache` | Two visible turns each write `1,000 × 5 / 1m = $0.005`. The `309`-second gap exceeds the five-minute lifetime. The return request records `1,000` cold input tokens worth `$0.005`. |
| `same-turn-gap` | Two requests in one visible turn have the same `309`-second gap. It yields zero inferred expiry returns. |
| `cache-write-warning` | Five requests each write `240,000` tokens. The `1,200,000` writes cost `$6`, exceed half the input, and trigger the cache-write warning. |
| `subagent` | The parent and child each have an estimated cost of `$0.0008`. The recorded model cost is `$0.0016` for their combined requests. The child carries the parent tool-use id. |
| `denied-error` | One request costs `$0.0008`. Its error result records one Bash denial, a rate-limit status, and an error terminal reason. |
| `no-input` | Sonnet output costs `100 × 10 / 1m = $0.001`. With zero input, the cache-read share is `null`. |

The audit runs a command once per fixture. `{}` becomes the fixture path. It compares expected keys and accepts a dollar difference up to `$0.0001`.

```bash
node cli/test/fixtures/stream/audit.mjs -- node cli/dist/arc.cjs cost {} --json
```

For a caller with different key names, pass a JSON map from corpus key paths to caller key paths.

```bash
node cli/test/fixtures/stream/audit.mjs --map caller-map.json -- node caller/stats.js {}
```
