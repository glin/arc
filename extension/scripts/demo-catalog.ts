import * as fs from 'node:fs';
import * as path from 'node:path';
import { readModels as codexModels, readAppliedDefaults as codexDefaults } from '../src/codexwire.ts';
import { readModels as claudeModels, readAppliedDefaults as claudeDefaults } from '../src/claudewire.ts';
import type { DefaultContext } from '../src/view/model-picks.ts';

// Prompt-free provider responses keep model capabilities and applied defaults together.
const responses = Object.fromEntries(
  ['codex-models', 'claude-models', 'codex-defaults', 'claude-defaults', 'codex-requirements'].map((name) => [
    name,
    JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-catalog', `${name}.json`), 'utf8')),
  ]),
);
const codex = codexModels(responses['codex-models'], 0);
const claude = claudeModels(responses['claude-models'], 0);
if (!codex || !claude) throw new Error('Demo provider responses have no model catalog.');

export const DEMO_MODELS = { codex: codex.models, claude: claude.models };
export function codexDefaultContext(configuration: unknown, catalog: unknown, policy: unknown): DefaultContext {
  const models = codexModels(catalog, 0)?.models ?? [];
  return {
    base: codexDefaults(configuration, catalog, policy),
    models: Object.fromEntries(
      models.map((model) => [model.value, codexDefaults(configuration, catalog, policy, model.value)]),
    ),
  };
}

export const DEMO_DEFAULTS: Record<string, DefaultContext> = {
  codex: codexDefaultContext(responses['codex-defaults'], responses['codex-models'], responses['codex-requirements']),
  claude: { base: claudeDefaults(responses['claude-defaults']) },
};
