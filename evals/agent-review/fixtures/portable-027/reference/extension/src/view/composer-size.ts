// Browser-safe prompt box sizing rules.

export const PROMPT_FLOOR_MIN_EM = 3.6;
export const PROMPT_LINE_EM = 1.45;

export function clampPromptFloor(value: unknown, ceilingEm: number): number {
  const ceiling =
    typeof ceilingEm === 'number' && Number.isFinite(ceilingEm)
      ? Math.max(PROMPT_FLOOR_MIN_EM, ceilingEm)
      : Number.POSITIVE_INFINITY;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return PROMPT_FLOOR_MIN_EM;
  }
  return Math.round(Math.min(ceiling, Math.max(PROMPT_FLOOR_MIN_EM, value)) * 100) / 100;
}

export function promptFloorAfterKey(key: string, currentEm: number, ceilingEm: number): number | null {
  if (key === 'Home') {
    return PROMPT_FLOOR_MIN_EM;
  }
  if (key === 'End') {
    return clampPromptFloor(ceilingEm, ceilingEm);
  }
  if (key === 'ArrowUp') {
    return clampPromptFloor(currentEm + PROMPT_LINE_EM, ceilingEm);
  }
  if (key === 'ArrowDown') {
    return clampPromptFloor(currentEm - PROMPT_LINE_EM, ceilingEm);
  }
  return null;
}

export function promptFloorLines(em: number, verticalPaddingEm: number): number {
  return Math.max(1, Math.ceil((em - verticalPaddingEm) / PROMPT_LINE_EM - 1e-9));
}
