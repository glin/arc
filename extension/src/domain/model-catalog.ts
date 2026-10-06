import { WINDOW_SUFFIX } from './model-identity';

export interface EffortChoice {
  value: string;
  label: string;
  description: string;
}

// One model the reader can pick, as the agent describes itself. `value` is what goes back
// on the wire. `resolvedModel` is the exact model identity when the agent supplies one, so
// pricing never has to infer a generation from `label` or `description`. `efforts` is empty
// for a model that takes no effort setting, which is how the panel knows to offer none.
export interface ModelChoice {
  value: string;
  resolvedModel?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  label: string;
  description: string;
  efforts: EffortChoice[];
}

// A saved or inherited value can add a window to a listed value, as `opus[1m]` adds one to `opus`.
// It matches the one row whose value is the same without its window.
export function windowedChoice<T extends { value: string }>(models: readonly T[], value: string | undefined): T | null {
  const bare = (value ?? '').toLowerCase().replace(WINDOW_SUFFIX, '').trim();
  if (bare === '' || bare === 'default') return null;
  const found = models.filter((item) => item.value.toLowerCase().replace(WINDOW_SUFFIX, '').trim() === bare);
  return found.length === 1 ? found[0] : null;
}
