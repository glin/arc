// Admission limits for explicit saved-session captures. Panel reads keep their own budgets.
export const EXPORT_LIMITS = {
  sliceBytes: 256 * 1024,
  recordBytes: 8 * 1024 * 1024,
  turnBytes: 16 * 1024 * 1024,
  pageBytes: 48 * 1024 * 1024,
  sourceBytes: 256 * 1024 * 1024,
  sessions: 128,
  relationships: 4096,
  turns: 20000,
  totalSourceBytes: 1024 * 1024 * 1024,
  inventoryPaths: 100000,
  inventoryBytes: 32 * 1024 * 1024,
  dispatchIdentities: 20000,
  assetBytes: 2 * 1024 * 1024,
  initialCards: 20,
  retainedBytes: 32 * 1024 * 1024,
} as const;

export interface ExportReadLimits {
  sliceBytes: number;
  recordBytes: number;
  turnBytes: number;
  pageBytes: number;
}

export interface ExportRelationshipLimits {
  recordBytes: number;
  dispatchIdentities: number;
  relationships: number;
}

export class ExportLimitError extends Error {
  constructor(
    public readonly boundary: string,
    public readonly limit: number,
  ) {
    super(`The session exceeds the ${boundary} limit (${limit}).`);
    this.name = 'ExportLimitError';
  }
}
