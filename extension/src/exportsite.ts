import { EXPORT_LIMITS } from './exportlimits';
import { checkExportCancellation, type ExportTransaction } from './exportwriter';
import type { SessionExport, ExportTurn, ExportCompaction, ExportUsage, ExportPage } from './exportdata';
import type { SiteAsset, SiteBlock, SiteCard, SiteManifest, SitePage } from './webview/export-model';
import { isCacheLifetime, type Turn, type TurnUsage, type Compaction } from './transcript';
import { toCard, toCompactionCard } from './turncard';
import type { CardView } from './webview/payload-contracts';
import { renderRichMarkdown } from './richtext';

export interface ExportSiteAssets {
  script: string;
  stylesheet: string;
}

// JSON remains literal data inside classic scripts, including closing tags and Unicode line separators.
export function exportScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function usage(value: ExportUsage): TurnUsage {
  return {
    requests: value.requests ?? 0,
    input: value.input ?? 0,
    cacheRead: value.cacheRead ?? 0,
    cacheWrite1h: value.cacheWrite1h ?? 0,
    cacheWrite5m: value.cacheWrite5m ?? 0,
    cacheWrite30m: value.cacheWrite30m ?? 0,
    output: value.output ?? 0,
    thinking: value.thinking ?? 0,
  };
}

// Builder output crosses a second allowlist. Paths, resume metadata, action records and HTML never cross it.
export function exportCard(value: ReturnType<typeof toCard> | ReturnType<typeof toCompactionCard>): CardView {
  const turn = value.kind === 'turn' ? value : null;
  return {
    kind: value.kind,
    key: value.key,
    sessionId: value.sessionId,
    status: turn?.status ?? 'done',
    statusWord: value.statusWord,
    relative: value.relative,
    absolute: value.absolute,
    duration: value.duration,
    durationWord: value.durationWord,
    durationDetail: value.durationDetail,
    lastRelative: turn?.lastRelative ?? value.relative,
    lastAbsolute: turn?.lastAbsolute ?? value.absolute,
    label: value.label,
    agent: turn?.agent ?? '',
    model: turn?.model ?? null,
    effort: turn?.effort ?? null,
    headline: value.headline,
    prompt: turn?.prompt ?? '',
    delegation: '',
    promptHeading: turn?.promptHeading ?? '',
    promptNotice: '',
    summary: value.summary,
    summaryHtml: renderRichMarkdown(value.summary, undefined, true),
    startedAt: turn?.startedAt ?? (value as ReturnType<typeof toCompactionCard>).at,
    endedAt: turn?.endedAt ?? (value as ReturnType<typeof toCompactionCard>).at,
    live: false,
    ...(turn ? { fileCount: turn.fileCount, added: turn.added, removed: turn.removed } : {}),
    chips: value.chips.map((chip) => ({
      kind: chip.kind,
      metric: chip.metric,
      label: chip.label,
      detail: chip.detail,
      name: chip.name,
      added: chip.added,
      removed: chip.removed,
      running: chip.running,
      level: chip.level,
    })),
  };
}

function turnCard(value: ExportTurn, agent: 'claude' | 'codex', session: string, capturedAt: number): CardView {
  const prompt =
    value.blocks.find((block) => block.kind === 'prompt' || block.kind === 'assignment')?.text.slice(0, 256) ?? '';
  const summary =
    [...value.blocks]
      .reverse()
      .find((block) => block.kind === 'answer')
      ?.text.slice(0, 512) ?? '';
  const turn: Turn = {
    agent,
    sessionId: session,
    sessionTitle: null,
    promptId: value.key,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    prompt,
    summary,
    answers: [],
    model: value.model,
    provider: value.provider,
    effort: value.effort,
    files: value.files.map((file) => ({
      path: file.path,
      added: file.added ?? 0,
      removed: file.removed ?? 0,
      isNew: file.isNew,
      edits: [],
      ...(file.added === null || file.removed === null ? { countsUnknown: true as const } : {}),
    })),
    agents: value.agents.map((agent) => ({
      id: agent.key,
      description: agent.description,
      agentType: agent.agentType,
      model: agent.model,
      effort: agent.effort,
      status: agent.status,
      startedAt: agent.startedAt,
      durationMs: agent.durationMs,
      tokens: agent.tokens,
      toolUses: agent.toolUses,
      spend: [],
      spendFound: false,
      spendPartial: true,
    })),
    commits: [],
    usage: usage(value.usage),
    usageParts: value.usageParts.map((part) => ({
      model: part.model,
      provider: part.provider,
      contextWindow: part.contextWindow,
      contextBand: part.contextBand,
      inferenceClass: part.inferenceClass ?? null,
      serviceTier: part.serviceTier,
      unclassifiedCacheWrite: part.unclassifiedCacheWrite,
      incomplete: part.incomplete,
      ...(part.requestCountExact ? {} : { requestCountExact: false as const }),
      usage: usage(part.usage),
    })),
    contextTokens: value.context.tokens ?? 0,
    contextWindow: value.context.window,
    contextRequest: value.context.request
      ? {
          ...value.context.request,
          lifetime: isCacheLifetime(value.context.request.lifetime) ? value.context.request.lifetime : null,
          inferenceClass: value.context.request.inferenceClass ?? null,
        }
      : undefined,
    outputRate: value.outputRate ?? undefined,
    toolUses: value.activity.calls,
    toolCounts: value.activity.counts,
    toolTally: {},
    laterPrompts: [],
    steps: [],
    updates: [],
    stepCount: value.activity.calls,
    stepKinds: value.activity.categories,
    failedOrdinals: [],
    skillUses: [],
    skillUseCount: 0,
    failures: [],
    interrupted: value.interrupted,
    finished: value.finished,
    error: value.error,
  };
  const card = exportCard(toCard(turn, false, capturedAt));
  card.key = value.key;
  if (value.commits.length)
    card.chips?.push({
      kind: 'plain',
      metric: 'commits',
      label: `${value.commits.length} commit${value.commits.length === 1 ? '' : 's'}`,
      detail: 'Recorded commit facts are in Recorded figures and changes.',
    });
  if (value.changes === 'partial' && !value.files.length)
    card.chips = card.chips?.filter((chip) => chip.metric !== 'files');
  if (!value.finished) {
    card.status = 'stopped';
    card.statusWord = 'Unfinished at capture';
    card.label = `${card.statusWord}. ${card.label}`;
  }
  card.summaryHtml ||= '<p>Recorded details</p>';
  return card;
}

function compactionCard(
  value: ExportCompaction,
  session: string,
  firstRequestCacheRead: number | null,
  capturedAt: number,
): CardView {
  const compaction: Compaction = {
    sessionId: session,
    at: value.at,
    summary: value.summary.slice(0, 512),
    trigger: value.trigger,
    model: value.model,
    provider: value.provider,
    contextBefore: value.contextBefore ?? 0,
    contextAfter: value.contextAfter ?? 0,
    droppedTokens: value.droppedTokens ?? 0,
    durationMs: value.durationMs ?? 0,
    ...(value.usage ? { usage: usage(value.usage) } : {}),
    previousRequest: value.previousRequest
      ? {
          ...value.previousRequest,
          cacheRead: value.previousRequest.cacheRead ?? undefined,
          cacheWrite: value.previousRequest.cacheWrite ?? undefined,
          lifetime:
            value.previousRequest.lifetime === '1h' ||
            value.previousRequest.lifetime === '5m' ||
            value.previousRequest.lifetime === '30m'
              ? value.previousRequest.lifetime
              : null,
          at: value.previousRequest.at,
          inferenceClass: value.previousRequest.inferenceClass ?? null,
        }
      : null,
    summaryChars: value.summaryChars ?? undefined,
    retainedContext: value.retainedContext ?? undefined,
    contextWindow: value.contextWindow,
    inferenceClass: value.inferenceClass,
    serviceTier: value.serviceTier,
    firstRequestCacheRead: firstRequestCacheRead ?? undefined,
  };
  const card = exportCard(toCompactionCard(compaction, capturedAt));
  card.key = value.key;
  card.summaryHtml ||= '<p>Recorded details</p>';
  return card;
}

export function* exportTextChunks(text: string): Generator<string> {
  let yielded = false;
  let start = 0;
  let bytes = 0;
  let position = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > EXPORT_LIMITS.textBytes) {
      yield text.slice(start, position);
      yielded = true;
      start = position;
      bytes = 0;
    }
    bytes += size;
    position += character.length;
  }
  if (position > start || !yielded) yield text.slice(start);
}

export async function projectSessionSite(
  model: SessionExport,
  writer: ExportTransaction,
  assets: ExportSiteAssets,
): Promise<void> {
  let sequence = 0;
  const asset = async (data: unknown): Promise<SiteAsset> => {
    checkExportCancellation(writer.signal);
    const id = `d${(++sequence).toString(36)}`;
    const script = `window.__arcExportReceive(${exportScriptJson(id)},${exportScriptJson(data)});\n`;
    return { id, file: await writer.writeAsset('js', script), bytes: Buffer.byteLength(script) };
  };
  const blocks = async (values: ExportTurn['blocks']): Promise<SiteAsset[]> => {
    const pages: SiteAsset[] = [];
    let page: SiteBlock[] = [];
    let pageBytes = 0;
    for (const block of values) {
      const chunks: SiteAsset[] = [];
      for (const raw of exportTextChunks(block.text))
        chunks.push(await asset({ raw, html: renderRichMarkdown(raw, undefined, true) }));
      const projected: SiteBlock = {
        key: block.key,
        kind: block.kind,
        at: block.at,
        sourceOrder: block.sourceOrder,
        notResponse: block.notResponse,
        preview: block.text.slice(0, 256),
        chunks,
      };
      const bytes = Buffer.byteLength(exportScriptJson(projected));
      if (page.length && pageBytes + bytes > EXPORT_LIMITS.assetBytes / 2) {
        pages.push(await asset(page));
        page = [];
        pageBytes = 0;
      }
      page.push(projected);
      pageBytes += bytes;
    }
    if (page.length) pages.push(await asset(page));
    return pages;
  };
  const sessions: SiteManifest['sessions'] = [];
  for (const session of model.sessions) {
    const pages: SitePage[] = [];
    let cards: SiteCard[] = [];
    let bytes = 0;
    const flush = async () => {
      if (cards.length) pages.push({ ...(await asset(cards)), keys: cards.map((entry) => entry.card.key) });
      cards = [];
      bytes = 0;
    };
    for (const spool of session.pages) {
      const page = await writer.readSpool<ExportPage>(spool);
      const entries = [
        ...page.turns.map((turn) => ({ at: turn.startedAt, turn })),
        ...page.compactions.map((compaction) => ({ at: compaction.at, compaction })),
      ].sort((a, b) => b.at - a.at);
      for (const entry of entries) {
        let projected: SiteCard;
        if ('turn' in entry) {
          const { blocks: text, ...facts } = entry.turn;
          projected = {
            card: turnCard(entry.turn, session.agent, session.key, model.capturedAt),
            bodies: await blocks(text),
            facts: await asset(facts),
            relationships: entry.turn.relationships,
          };
        } else {
          const { summary, ...facts } = entry.compaction;
          projected = {
            card: compactionCard(entry.compaction, session.key, session.firstRequestCacheRead, model.capturedAt),
            bodies: await blocks([
              {
                key: `${entry.compaction.key}-summary`,
                kind: 'answer',
                at: entry.compaction.at,
                sourceOrder: null,
                notResponse: null,
                text: summary,
              },
            ]),
            facts: await asset(facts),
          };
        }
        const size = Buffer.byteLength(exportScriptJson(projected));
        if (
          cards.length &&
          (cards.length >= EXPORT_LIMITS.initialCards || bytes + size > EXPORT_LIMITS.initialTextBytes / 2)
        )
          await flush();
        cards.push(projected);
        bytes += size;
      }
    }
    await flush();
    sessions.push({ ...session, pages });
  }
  const manifest: SiteManifest = { ...model, sessions };
  const data = await writer.writeAsset('js', `window.__arcExportManifest=${exportScriptJson(manifest)};\n`);
  const script = await writer.writeAsset('js', assets.script);
  const stylesheet = await writer.writeAsset('css', assets.stylesheet);
  await writer.writeIndex(
    `<!DOCTYPE html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'"><title>Arc session</title><link rel="stylesheet" href="./${stylesheet}"></head><body class="vscode-dark export-page"><header id="export-header"></header><aside id="export-sessions" aria-label="Session list"></aside><main id="list" aria-label="Timeline"><p role="status">Loading session...</p></main><script src="./${data}" defer></script><script src="./${script}" defer></script></body></html>`,
  );
}
