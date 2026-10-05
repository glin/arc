
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


import assert from "node:assert";
var require2 = createRequire(import.meta.url);
var ROOT = process.argv[2];
var RUNTIME = require2(ROOT + "/runtime.cjs");
var { composerView, sessionSettings, adoptSessionIdentity, sessionLauncherView, launcherProfile, sessionSettingsForProfile } = RUNTIME.modules["extension/src/composerview.ts"];
var { launcherCustomRequest } = RUNTIME.modules["extension/src/view/launcher.ts"];
var { pickedEffort } = RUNTIME.modules["extension/src/agenthost.ts"];
var COMMANDS = [
  { kind: "command", name: "compact", description: "Compact the session", argumentHint: "" },
  { kind: "command", name: "context", description: "Show context use", argumentHint: "" },
  { kind: "command", name: "safe-compact", description: "Save findings first", argumentHint: "" },
  { kind: "command", name: "model", description: "Pick a model", argumentHint: "" }
];
var MODELS = [
  {
    value: "opus-5",
    label: "Opus 5",
    description: "The one that thinks hardest",
    efforts: [
      { value: "high", label: "high", description: "Thinks for longer before it answers" },
      { value: "low", label: "low", description: "Answers sooner" }
    ]
  },
  { value: "haiku-5", label: "Haiku 5", description: "The quick one", efforts: [] }
];
function composerState(over = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(over, key);
  const selectedModel = has("model") ? over.model ?? "" : "opus-5";
  const selectedEffort = has("effort") ? over.effort ?? "" : "high";
  const ran = has("ran") ? over.ran ?? null : null;
  const { model: _model, effort: _effort, ran: _ran, settings, ...rest } = over;
  return {
    agent: "claude",
    // The box and the draft hold the same words except while the walk is standing, so a test
    // that names one names both.
    onScreen: over.draft ?? "",
    session: "Embedded agent input",
    models: MODELS,
    commands: COMMANDS,
    claudeSkills: null,
    settings: settings ?? {
      selectedModel,
      selectedEffort,
      effortModel: selectedModel,
      pendingModel: null,
      pendingEffort: null,
      confirmedModel: ran?.model ?? null,
      confirmedEffort: ran?.effort ?? null
    },
    askMode: void 0,
    context: { used: 41e4, max: 1e6 },
    mcpServers: [],
    draft: "",
    queued: [],
    history: [],
    running: false,
    comments: [],
    sessionId: "session-1",
    live: [],
    ...rest
  };
}
test("omitted models keep supported effort through metadata changes and adoption", () => {
  for (const agent of ["claude", "codex"]) {
    const models = [
      {
        value: "model",
        resolvedModel: "model-identity",
        label: "Model",
        description: "",
        efforts: [{ value: "high", label: "High", description: "" }]
      },
      {
        value: "limited",
        label: "Limited",
        description: "",
        efforts: [{ value: "low", label: "Low", description: "" }]
      }
    ];
    const profile = { agent, model: "", effort: "high", permissionMode: "", source: "custom" };
    for (const defaultModel of ["model-identity", "limited"]) {
      for (const status of ["ready", "loading", "unavailable"]) {
        const defaults = {
          base: {
            status,
            model: status === "ready" ? defaultModel : null,
            effort: status === "ready" ? defaultModel === "model-identity" ? "high" : "low" : null,
            reason: ""
          }
        };
        const state = composerState({ agent, models, model: "", effort: "high", profile, defaults });
        const view = sessionLauncherView(state, [profile], { [agent]: models }, [{ id: "saved", ...profile }], {
          [agent]: defaults
        });
        assert.equal(view.inherited?.profile.model, "");
        assert.equal(view.inherited?.profile.effort, "high");
        assert.equal(view.pinned[0].available, true);
        const neutral = sessionLauncherView(null, [profile], { [agent]: models }, [], { [agent]: defaults });
        assert.equal(neutral.primary?.profile.effort, "high");
        const request = { kind: "custom", ...profile };
        assert.equal(launcherProfile(neutral, request)?.effort, "high");
        assert.equal(launcherProfile(neutral, { ...request, effort: "retired" }), null);
        assert.equal(launcherCustomRequest(neutral, request)?.effort, "high");
        const settings = sessionSettingsForProfile(profile, models, defaults);
        const moved = adoptSessionIdentity(
          {
            drafts: {},
            queues: {},
            live: {},
            settings: { draft: settings },
            profiles: { draft: profile },
            railOrder: [],
            showing: "draft",
            pinned: [],
            archived: []
          },
          "draft",
          "actual"
        );
        assert.equal(sessionSettings(moved.settings, "actual").selectedModel, "");
        assert.equal(sessionSettings(moved.settings, "actual").selectedEffort, "high");
        assert.equal(sessionSettings(moved.settings, "actual").effortModel, "model");
        const adopted = sessionSettings(moved.settings, "actual");
        assert.equal(
          pickedEffort(adopted.selectedEffort, { models, readAt: 1 }, adopted.effortModel || adopted.selectedModel),
          "high"
        );
        const unsupported = { ...profile, model: "limited" };
        assert.equal(launcherProfile(neutral, { kind: "custom", ...unsupported }), null);
        assert.equal(launcherCustomRequest(neutral, unsupported), null);
        const explicitState = composerState({
          agent,
          models,
          model: "limited",
          effort: "high",
          profile: unsupported,
          defaults
        });
        assert.equal(
          sessionLauncherView(explicitState, [], { [agent]: models }, [], { [agent]: defaults }).inherited?.profile.effort,
          ""
        );
        for (const model of ["model", "model-identity"]) {
          const explicit = { ...profile, model };
          assert.equal(launcherProfile(neutral, { kind: "custom", ...explicit })?.model, model);
          const exact = sessionSettingsForProfile(explicit, models, defaults);
          assert.equal(exact.selectedModel, model);
          assert.equal(exact.effortModel, model);
          assert.equal(pickedEffort(exact.selectedEffort, { models, readAt: 1 }, exact.effortModel), "high");
        }
        if (status === "ready" && defaultModel === "model-identity") {
          assert.ok(composerView(state)?.draftTag?.detail.includes("Model (default)"));
          assert.ok(neutral.primary?.detail.includes("High (default)"));
          assert.ok(neutral.words.primaryDetail.includes("Model (default)"));
        }
      }
    }
    const live = composerState({
      agent,
      models,
      model: "",
      effort: "",
      ran: { model: "model-identity", effort: "high" },
      defaults: { base: { status: "ready", model: "model-identity", effort: "high", reason: "" } }
    });
    assert.equal(composerView(live)?.picks.find((pick) => pick.control === "effort")?.label, "High (default)");
  }
});
test("ordinary explicit model and retired effort", () => {
  const models = [{ value: "model", resolvedModel: "model-identity", label: "Model", description: "", efforts: [{ value: "high", label: "High", description: "" }] }];
  for (const agent of ["claude", "codex"]) {
    const view = sessionLauncherView(null, [], { [agent]: models });
    const request = { kind: "custom", agent, model: "model", effort: "high", permissionMode: "" };
    assert.equal(launcherProfile(view, request)?.effort, "high");
    assert.equal(launcherProfile(view, { ...request, effort: "retired" }), null);
    assert.equal(launcherProfile(view, { ...request, model: "missing" }), null);
  }
});
await finish();
for (const directory of globalThis.qualificationDirs ?? []) require2("node:fs").rmSync(directory, { recursive: true, force: true });
