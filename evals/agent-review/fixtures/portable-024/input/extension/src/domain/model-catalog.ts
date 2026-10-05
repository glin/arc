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
