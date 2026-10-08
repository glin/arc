import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentPrompt, PromptAsset } from './agentwire';

import { MAX_PROMPT_ASSETS, MAX_PROMPT_ASSET_BYTES, MAX_PROMPT_ASSET_TOTAL_BYTES } from './domain/prompt-assets';
export { MAX_PROMPT_ASSETS, MAX_PROMPT_ASSET_BYTES, MAX_PROMPT_ASSET_TOTAL_BYTES };

const CLAUDE_ASSET_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

export function assetKindWord(mime: string): string {
  if (mime === 'application/pdf') {
    return 'PDF';
  }
  return mime.startsWith('text/') ? 'text' : 'file';
}

export function splitAssetName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

export function pastedAssetName(name: string, now: Date = new Date()): string {
  const match = /^image\.(png|jpe?g|gif|webp)$/i.exec(name);
  if (!match) {
    return name;
  }
  const two = (value: number) => String(value).padStart(2, '0');
  return `pasted-${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}.${match[1].toLowerCase()}`;
}

export function agentTakesAsset(agent: string, mime: string): boolean {
  return agent === 'codex' || (agent === 'claude' && (CLAUDE_ASSET_MIMES.has(mime) || mime.startsWith('text/')));
}

export function unsupportedPromptAsset<T extends { mime: string }>(agent: string, assets: readonly T[]): T | null {
  return assets.find((asset) => !agentTakesAsset(agent, asset.mime)) ?? null;
}

export interface StoredPromptAsset {
  id: string;
  name: string;
  mime: string;
  size: number;
  digest: string;
}

export interface PromptAssetInput {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface PromptAssetMetadata {
  name: string;
  mime: string;
  size: number;
}

export interface PromptAssetStagingOperation {
  browserSession: string;
  target: string;
}

export function adoptPromptAssetOperationTarget(
  operation: PromptAssetStagingOperation,
  provisional: string,
  actual: string,
): boolean {
  if (operation.target !== provisional) {
    return false;
  }
  operation.target = actual;
  return true;
}

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const SHA256 = /^[0-9a-f]{64}$/i;

export function normalizeAssetName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const name = raw.normalize('NFC').trim();
  if (!name || name === '.' || name === '..' || name.length > 255) {
    return null;
  }
  if (name.includes('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) {
    return null;
  }
  return name;
}

export function normalizeAssetMime(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const mime = raw.trim().toLowerCase();
  return mime.length <= 127 && MIME.test(mime) ? mime : null;
}

export function assetMimeForName(name: string): string {
  const extension = path.extname(name).toLowerCase();
  return (
    (
      {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'text/json',
        '.csv': 'text/csv',
        '.tsv': 'text/tab-separated-values',
        '.js': 'text/javascript',
        '.ts': 'text/typescript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.xml': 'text/xml',
        '.yaml': 'text/yaml',
        '.yml': 'text/yaml',
      } as Record<string, string>
    )[extension] ?? 'application/octet-stream'
  );
}

export function browserAssetMime(name: string, reported: string): string {
  const named = assetMimeForName(name);
  return named !== 'application/octet-stream' ? named : (normalizeAssetMime(reported) ?? 'application/octet-stream');
}

export function normalizeStoredPromptAsset(raw: unknown): StoredPromptAsset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === 'string' && ASSET_ID.test(value.id) ? value.id.toLowerCase() : null;
  const name = normalizeAssetName(value.name);
  const mime = normalizeAssetMime(value.mime);
  const size =
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    value.size <= MAX_PROMPT_ASSET_BYTES
      ? value.size
      : null;
  const digest = typeof value.digest === 'string' && SHA256.test(value.digest) ? value.digest.toLowerCase() : null;
  return id && name && mime && size !== null && digest ? { id, name, mime, size, digest } : null;
}

export function normalizePromptAssetBook(raw: unknown): Record<string, StoredPromptAsset[]> {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, StoredPromptAsset[]> = {};
  for (const [session, value] of Object.entries(source)) {
    if (!session || !Array.isArray(value)) {
      continue;
    }
    const assets: StoredPromptAsset[] = [];
    let total = 0;
    for (const rawAsset of value) {
      const asset = normalizeStoredPromptAsset(rawAsset);
      if (!asset || assets.some((one) => one.id === asset.id)) {
        continue;
      }
      if (assets.length >= MAX_PROMPT_ASSETS || total + asset.size > MAX_PROMPT_ASSET_TOTAL_BYTES) {
        break;
      }
      assets.push(asset);
      total += asset.size;
    }
    if (assets.length) {
      out[session] = assets;
    }
  }
  return out;
}

export function stagedAssetPath(root: string, id: string): string {
  if (!ASSET_ID.test(id)) {
    throw new Error('the attachment id is invalid');
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, id.toLowerCase());
  if (path.dirname(resolved) !== base) {
    throw new Error('the attachment path leaves its staging directory');
  }
  return resolved;
}

export function resolvePromptAssets(root: string, stored: readonly StoredPromptAsset[]): PromptAsset[] {
  const assets = promptAssetsFromStored(root, stored);
  validateResolvedPromptAssets(assets);
  return assets;
}

export function validatePromptAssetBytes(asset: PromptAsset, bytes: Uint8Array): void {
  if (bytes.byteLength !== asset.size) {
    throw new Error(`${asset.name} does not match its saved attachment descriptor`);
  }
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.digest) {
    throw new Error(`${asset.name} does not match its saved attachment descriptor`);
  }
}

export function validateResolvedPromptAssets(assets: readonly PromptAsset[]): void {
  for (const asset of assets) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(asset.path);
    } catch {
      throw new Error(`${asset.name} is no longer available in attachment storage`);
    }
    if (!stat.isFile() || stat.size !== asset.size) {
      throw new Error(`${asset.name} does not match its saved attachment descriptor`);
    }
    validatePromptAssetBytes(asset, fs.readFileSync(asset.path));
  }
}

export function promptAssetsFromStored(root: string, stored: readonly StoredPromptAsset[]): PromptAsset[] {
  return stored.map((value) => {
    const asset = normalizeStoredPromptAsset(value);
    if (!asset) {
      throw new Error('an attachment descriptor is invalid');
    }
    return { ...asset, path: stagedAssetPath(root, asset.id) };
  });
}

export function storedAssetsForPrompt(
  stored: readonly StoredPromptAsset[],
  prompt: readonly PromptAsset[],
): StoredPromptAsset[] {
  const ids = new Set(prompt.map((asset) => asset.id));
  return stored.filter((asset) => ids.has(asset.id));
}

export function validatePromptAssetBatch(
  existing: readonly StoredPromptAsset[],
  inputs: readonly PromptAssetMetadata[],
): void {
  if (existing.length + inputs.length > MAX_PROMPT_ASSETS) {
    throw new Error(`A prompt can have at most ${MAX_PROMPT_ASSETS} attached files.`);
  }
  let total = existing.reduce((sum, asset) => sum + asset.size, 0);
  for (const input of inputs) {
    const name = normalizeAssetName(input.name);
    if (!name) {
      throw new Error('An attached file has an invalid name.');
    }
    if (!normalizeAssetMime(input.mime)) {
      throw new Error(`${name} has an invalid media type.`);
    }
    if (!Number.isSafeInteger(input.size) || input.size < 0) {
      throw new Error(`${name} has an invalid size.`);
    }
    if (input.size > MAX_PROMPT_ASSET_BYTES) {
      throw new Error(`${name} is larger than the per-file attachment limit.`);
    }
    total += input.size;
    if (total > MAX_PROMPT_ASSET_TOTAL_BYTES) {
      throw new Error(`${name} would make this prompt exceed the total attachment limit.`);
    }
  }
}

export function mergePromptAssets(
  current: readonly StoredPromptAsset[],
  written: readonly StoredPromptAsset[],
): StoredPromptAsset[] {
  validatePromptAssetBatch(current, written);
  const ids = new Set(current.map((asset) => asset.id));
  if (written.some((asset) => ids.has(asset.id))) {
    throw new Error('An attached file has a duplicate staging id.');
  }
  return [...current, ...written];
}

export function promptAssetsSafeToDelete(
  book: Readonly<Record<string, readonly StoredPromptAsset[]>>,
  inHandoff: ReadonlySet<string>,
  candidates: readonly StoredPromptAsset[],
): StoredPromptAsset[] {
  const described = new Set(
    Object.values(book)
      .flat()
      .map((asset) => asset.id),
  );
  return candidates.filter((asset) => !described.has(asset.id) && !inHandoff.has(asset.id));
}

export function promptAssetReleaseIndexes(
  batchTurnIds: readonly (number | null)[],
  all: boolean,
  ended?: number | readonly number[],
): number[] {
  if (all) {
    return batchTurnIds.map((_, index) => index);
  }
  if (ended === undefined) {
    return [];
  }
  const endedTurnIds = new Set(typeof ended === 'number' ? [ended] : ended);
  return batchTurnIds.flatMap((turnId, index) => (turnId !== null && endedTurnIds.has(turnId) ? [index] : []));
}

// Codex can report turn completion before the host's prompt-acceptance promise returns.
// Keep that completion with the active handoff, including new-session handoffs awaiting their final session id.
export class PromptAssetCompletionBook {
  private handoffSequence = 0;
  private completionSequence = 0;
  private readonly handoffs = new Map<number, number>();
  private readonly completions = new Map<string, number>();

  begin(): number {
    const id = ++this.handoffSequence;
    this.handoffs.set(id, this.completionSequence);
    return id;
  }

  complete(session: string): void {
    if (!this.handoffs.size) {
      return;
    }
    this.completions.set(session, ++this.completionSequence);
  }

  finish(handoff: number, session: string): boolean {
    const beganAt = this.handoffs.get(handoff);
    if (beganAt === undefined) {
      return false;
    }
    this.handoffs.delete(handoff);
    const completed = (this.completions.get(session) ?? 0) > beganAt;
    if (!this.handoffs.size) {
      this.completions.clear();
    }
    return completed;
  }
}

export async function stagePromptAssets(
  root: string,
  inputs: readonly PromptAssetInput[],
): Promise<StoredPromptAsset[]> {
  for (const input of inputs) {
    if (!(input.bytes instanceof Uint8Array)) {
      throw new Error(`${normalizeAssetName(input.name) ?? 'An attached file'} did not contain readable bytes.`);
    }
  }
  validatePromptAssetBatch(
    [],
    inputs.map((input) => ({ ...input, size: input.bytes.byteLength })),
  );
  if (!inputs.length) {
    return [];
  }
  await fs.promises.mkdir(root, { recursive: true });
  const written: StoredPromptAsset[] = [];
  try {
    for (const input of inputs) {
      const id = crypto.randomUUID();
      const asset = {
        id,
        name: normalizeAssetName(input.name) as string,
        mime: normalizeAssetMime(input.mime) as string,
        size: input.bytes.byteLength,
        digest: crypto.createHash('sha256').update(input.bytes).digest('hex'),
      };
      await fs.promises.writeFile(stagedAssetPath(root, id), input.bytes, { flag: 'wx' });
      written.push(asset);
    }
  } catch (error) {
    await Promise.all(
      written.map((asset) => fs.promises.unlink(stagedAssetPath(root, asset.id)).catch(() => undefined)),
    );
    throw error;
  }
  return written;
}

export async function deleteStagedPromptAssets(root: string, assets: readonly StoredPromptAsset[]): Promise<void> {
  await Promise.all(
    assets.map(async (asset) => {
      const normalized = normalizeStoredPromptAsset(asset);
      if (!normalized) {
        return;
      }
      await fs.promises.unlink(stagedAssetPath(root, normalized.id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }),
  );
}

export function agentPrompt(text: string, assets: readonly PromptAsset[] = []): AgentPrompt {
  return { text, assets: [...assets] };
}

export function promptDisplayText(prompt: AgentPrompt): string {
  const text = prompt.text.trim();
  return text || `Attached: ${prompt.assets.map((asset) => asset.name).join(', ')}`;
}
