
import { createRequire } from "node:module";


var jobs = [];
var checks = [];
var test = (name, fn) => jobs.push({ name, fn });
test.each = (values) => (name, fn) => {
  for (const v of values) test(name, () => fn(...Array.isArray(v) ? v : [v]));
};
async function finish() {
  for (let i = 0; i < jobs.length; i++) {
    let pass = true;
    try {
      await jobs[i].fn();
    } catch (e) {
      console.error(e.stack);
      pass = false;
    }
    checks.push({ id: "check-" + i, role: jobs[i].name.startsWith("ordinary") ? "normal" : "symptom", pass });
  }
  console.log(JSON.stringify({ checks }));
}


import path2 from "node:path";
import fs2 from "node:fs";
import assert from "node:assert";


import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var tempDir = (prefix) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  (globalThis.qualificationDirs ??= []).push(directory);
  return directory;
};


var require2 = createRequire(import.meta.url);
var ROOT = process.argv[2];
var RUNTIME = require2(ROOT + "/runtime.cjs");
var { indexSpendFile, loadSpendLedger, prepareProjectSpendView, publicProjectSpendPrice, saveSpendLedger } = RUNTIME.modules["extension/src/projectspend.ts"];
var dir = () => tempDir("project-spend-");
var usage = () => ({
  input: 1,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  cacheWrite30m: 0,
  cacheRead: 0,
  output: 1,
  thinking: 0
});
var event = (timestamp, more = {}) => ({
  timestamp,
  agent: "Claude",
  provider: "anthropic",
  model: "model",
  contextWindow: null,
  billingClass: "metered",
  inferenceClass: null,
  serviceTier: null,
  reportedCost: null,
  usage: usage(),
  requestKey: null,
  ...more
});
var reducer = (state) => {
  let lines = state?.closedTurns ?? 0;
  return {
    parserKind: "claude",
    pushLine(line) {
      lines++;
      return line ? [JSON.parse(line)] : [];
    },
    snapshot: () => ({
      seenRequestKeys: [],
      closedTurns: lines,
      openTurn: false,
      openTurnAnswered: false,
      compactionCount: 0,
      recentCompactions: [],
      visibleTurns: 0,
      firstTurnAt: null,
      currentTurnStartedAt: null,
      currentTurnEndedAt: null,
      currentTurnOutcome: null
    })
  };
};
var stamp = (value) => new Date(value).getTime();
test("newline followed by NUL padding indexes an appended line the same after a rebuild", () => {
  const folder = dir();
  const file = path2.join(folder, "padded.jsonl");
  const first = JSON.stringify(event(stamp("2026-09-23T10:00:00"), { reportedCost: 2 })) + "\n";
  const padding = Buffer.alloc(19);
  fs2.writeFileSync(file, Buffer.concat([Buffer.from(first), padding]));
  fs2.utimesSync(file, /* @__PURE__ */ new Date("2026-09-23T10:00:00"), /* @__PURE__ */ new Date("2026-09-23T10:00:00"));
  const indexed = indexSpendFile(void 0, file, "one", reducer, 1).record;
  assert.equal(indexed.buckets[0].requests, 1);
  const storage = dir();
  saveSpendLedger(storage, "one", [indexed]);
  const loaded = loadSpendLedger(storage, "one").files[0];
  fs2.appendFileSync(file, JSON.stringify(event(stamp("2026-09-29T10:00:00"), { reportedCost: 3 })) + "\n");
  const resumed = indexSpendFile(loaded, file, "one", reducer, 2);
  assert.equal(resumed.rebuilt, false);
  assert.equal(resumed.record.offset, resumed.record.size);
  assert.equal(
    resumed.record.buckets.reduce((sum, bucket) => sum + bucket.requests, 0),
    2
  );
  assert.equal(
    prepareProjectSpendView([resumed.record], publicProjectSpendPrice, { now: stamp("2026-09-29T12:00:00") }).windows[0].display,
    "$3.00"
  );
  const rebuilt = indexSpendFile(void 0, file, "one", reducer, 3).record;
  assert.deepEqual(rebuilt.buckets, resumed.record.buckets);
  assert.equal(rebuilt.offset, rebuilt.size);
  assert.equal(rebuilt.trailing, "");
});
test("ordinary append and incomplete boundary", () => {
  const folder = dir(), file = path2.join(folder, "ordinary.jsonl");
  const first = JSON.stringify(event(stamp("2026-09-23T10:00:00"), { reportedCost: 2 })) + "\n";
  fs2.writeFileSync(file, first);
  const initial = indexSpendFile(void 0, file, "one", reducer, 1).record;
  fs2.appendFileSync(file, JSON.stringify(event(stamp("2026-09-29T10:00:00"), { reportedCost: 3 })) + "\n");
  const next = indexSpendFile(initial, file, "one", reducer, 2).record;
  assert.equal(next.buckets.reduce((sum, b) => sum + b.requests, 0), 2);
  assert.deepEqual(next.buckets, indexSpendFile(void 0, file, "one", reducer, 3).record.buckets);
  for (const tail of ["{", String.fromCharCode(0, 0) + "{"]) {
    fs2.writeFileSync(file, first + tail);
    const partial = indexSpendFile(void 0, file, "one", reducer, 4).record;
    assert.equal(partial.offset, Buffer.byteLength(first));
    assert.equal(partial.trailingBytes, Buffer.from(tail).toString("base64"));
  }
});
await finish();
for (const directory of globalThis.qualificationDirs ?? []) require2("node:fs").rmSync(directory, { recursive: true, force: true });
