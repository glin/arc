
import { createRequire } from "node:module";


var jobs = [];
var checks = [];
var test = (name, fn) => jobs.push({ name, fn });
test.each = (values) => (name, fn) => {
  for (const v of values) test(name, () => fn(...Array.isArray(v) ? v : [v]));
};
var vi = { waitFor: async (fn) => {
  const end = Date.now() + 2e3;
  while (true) {
    try {
      return fn();
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}, spyOn: (object, key) => {
  const old = object[key];
  return { mockImplementation(fn) {
    object[key] = fn;
    return this;
  }, mockRestore() {
    object[key] = old;
  } };
} };
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


import assert from "node:assert";
var require2 = createRequire(import.meta.url);
var ROOT = process.argv[2];
var RUNTIME = require2(ROOT + "/runtime.cjs");
var { normalizePanelState } = RUNTIME.modules["extension/src/turnview.ts"];
function queueRecoveryProvider(comments = []) {
  const writes = [];
  const provider = Object.create(PanelProvider.prototype);
  Object.assign(provider, {
    queues: {},
    drafts: {},
    boxText: {},
    assets: {},
    draftCommentIds: {},
    sentPrompts: {},
    picks: {},
    draftProfiles: {},
    sessionOrigins: {},
    railOrder: [],
    showing: "",
    promptsBySession: /* @__PURE__ */ new Map(),
    saved: normalizePanelState({ comments }),
    memento: {
      update(_key, value) {
        writes.push(structuredClone(value));
        return Promise.resolve();
      }
    },
    queueHandoffs: /* @__PURE__ */ new Set(),
    queuedEditReservations: /* @__PURE__ */ new Set(),
    queuedEditOffers: /* @__PURE__ */ new Map(),
    draftRevisions: /* @__PURE__ */ new Map(),
    typedRenames: /* @__PURE__ */ new Map(),
    repositoryScopeReady: true,
    pendingQueueDrains: /* @__PURE__ */ new Set(),
    attachmentStorageDir: null,
    clearSettlements: /* @__PURE__ */ new Map(),
    newDrafts: {},
    live: {},
    awaitingSessionRecords: {},
    readyHosts: /* @__PURE__ */ new Set(),
    assetCompletions: {
      begin() {
        return 1;
      },
      finish() {
        return false;
      }
    },
    assetHandoffs: /* @__PURE__ */ new Set(),
    assetIdsInHandoff: /* @__PURE__ */ new Set(),
    completedAssetTurns: /* @__PURE__ */ new Set(),
    deferredAssetDeletes: {},
    livePressHosts: /* @__PURE__ */ new Map(),
    staging: /* @__PURE__ */ new Set(),
    attachmentNotices: {},
    asks: [],
    sessionAliases: /* @__PURE__ */ new Map(),
    clearRoutes: /* @__PURE__ */ new Map(),
    post() {
      return Promise.resolve();
    },
    postRail() {
    },
    usagePayload() {
      return {};
    },
    cwdForSession() {
      return "C:\\ws";
    },
    rememberDrafts() {
    },
    rememberStarted() {
    },
    refresh() {
      return Promise.resolve();
    },
    dropCarriedAssets() {
    },
    sessionRows: ["source", "successor", "next"].map((id) => ({ id, label: id, agentKey: "codex" })),
    running: /* @__PURE__ */ new Set(),
    runningSinceKeys: /* @__PURE__ */ new Map(),
    newestBySession: /* @__PURE__ */ new Map(),
    newestCompactionBySession: /* @__PURE__ */ new Map(),
    liveActivity: {},
    models: {},
    commandLists: {},
    skillLists: {},
    mcpServers: {},
    askLevels: {}
  });
  return { provider, writes };
}
test.each(["storage", "acceptance"])(
  "submitted recovery freezes comment membership across queue note edit at %s",
  async (window) => {
    const comment = {
      id: "C",
      sessionId: "source",
      turnKey: "source:1",
      part: "summary",
      quote: "",
      note: "old captured comment",
      headline: "Turn",
      sessionTitle: "Source",
      turnAt: 1,
      at: 2
    };
    const { provider } = queueRecoveryProvider([comment]);
    const host = { webview: {} };
    Object.assign(provider, { hosts: [host], hostSessions: /* @__PURE__ */ new Map([[host, "source"]]), readyHosts: /* @__PURE__ */ new Set([host]) });
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    let stored;
    let writes = 0;
    provider.memento = {
      get: () => structuredClone(stored),
      update: async (_key, value) => {
        if (++writes === 1) await waiting;
        stored = structuredClone(value);
      }
    };
    let accept;
    const sent = [];
    provider.onSendPrompt = (_agent, _session, _cwd, prompt) => {
      sent.push(prompt.text);
      return new Promise((resolve) => {
        accept = resolve;
      });
    };
    const text = "frozen prompt";
    await provider.onMessage({ type: "draft", session: "source", text, keep: text, revision: 1 }, host);
    const pending = provider.onMessage(
      {
        type: "sendPrompt",
        session: "source",
        text,
        revision: 2,
        attempt: { id: window, order: 1, source: "source", revision: 2, text }
      },
      host
    );
    await vi.waitFor(() => assert.equal(writes, 1));
    const edited = { ...comment, offset: void 0, note: "new reader comment" };
    if (window === "storage") await provider.onMessage({ type: "note", note: { op: "write", note: edited } }, host);
    release();
    await pending;
    await vi.waitFor(() => assert.equal(sent.length, 1));
    if (window === "acceptance") await provider.onMessage({ type: "note", note: { op: "write", note: edited } }, host);
    assert.equal(provider.saved.comments[0].note, edited.note);
    assert.match(sent[0], /old captured comment/);
    assert.doesNotMatch(sent[0], /new reader comment/);
    accept({ delivered: true, reason: "", session: "source" });
    await vi.waitFor(() => assert.equal(provider.saved.submittedPrompts[0].accepted, true));
    assert.deepEqual(provider.saved.comments, [edited]);
    await provider.writeDrafts();
    assert.deepEqual(stored.comments, [edited]);
    const listener = vi.spyOn(PanelProvider.prototype, "wireEditorListeners").mockImplementation(() => {
    });
    let fresh;
    try {
      fresh = new PanelProvider("", {}, provider.memento);
      assert.deepEqual(fresh.saved.comments, [edited]);
    } finally {
      fresh?.dispose();
      listener.mockRestore();
    }
  }
);
var PanelProvider = RUNTIME.modules["extension/src/panelhost.ts"].PanelProvider;
test("ordinary delivery and refusal", () => {
  const fn = RUNTIME.modules["extension/src/composerview.ts"].commentsAfterSend;
  const sent = { id: "one", note: "note", at: 1, turnKey: "source:1", part: "summary", quote: "", headline: "Turn", sessionTitle: "Source", turnAt: 1 };
  const other = { ...sent, id: "two" };
  assert.deepEqual(fn([sent, other], [{ ...sent }], true), [other]);
  assert.deepEqual(fn([sent, other], [sent], false), [sent, other]);
  assert.deepEqual(fn([sent], [], true), [sent]);
});
await finish();
for (const directory of globalThis.qualificationDirs ?? []) require2("node:fs").rmSync(directory, { recursive: true, force: true });
