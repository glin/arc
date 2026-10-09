import { EXPORT_LIMITS } from './exportlimits';
import { checkExportCancellation, type ExportTransaction } from './exportwriter';
import type { SessionExport, ExportTurn, ExportCompaction, ExportUsage, ExportPage } from './exportdata';
import type { SiteAsset, SiteManifest, SitePage } from './webview/export-model';
import { isCacheLifetime, normalizeSessionTitle, type Turn, type TurnUsage, type Compaction } from './transcript';
import { toCard, toCompactionCard, sessionStats } from './turncard';
import type { CardView } from './webview/payload-contracts';
import { renderRichMarkdown } from './richtext';
import { createHash } from 'node:crypto';
import { railSessions, formatRelative } from './turnview';
import { formatCost } from './pricing';
import { staticPageBody } from './view/static-page';
import type { PanelSessionRow, PanelStat } from './webview/protocol';

export interface ExportSiteAssets {
  script: string;
  stylesheet: string;
}

// Escaped JSON preserves literal text before base64 encoding into inert data blocks.
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

// Keep recorded figures and readable text without editor actions or absolute metadata paths.
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
    delegation: turn?.delegation ?? '',
    promptHeading: turn?.promptHeading ?? '',
    promptNotice: turn?.promptNotice ?? '',
    summary: value.summary,
    earlierAnswers: turn?.earlierAnswers.map((answer) => ({
      at: answer.at,
      absolute: answer.absolute,
      summaryHtml: renderRichMarkdown(answer.summary, undefined, true),
    })),
    saidMessages: turn?.saidMessages.map((message) => ({
      id: message.id,
      kind: message.kind,
      at: message.at,
      text: message.text,
      when: message.when,
      absolute: message.absolute,
      answerIndex: message.answerIndex,
      summaryHtml: renderRichMarkdown(message.text, undefined, true),
    })),
    saidName: turn?.saidName,
    saidMix: turn?.saidMix,
    laterPrompts: turn?.laterPrompts.map((ask) => ({
      text: ask.text,
      when: ask.when,
      absolute: ask.absolute,
      label: ask.label,
    })),
    activity: turn?.activity
      .filter((row) => row.kind === 'message' || row.kind === 'ask')
      .map((row) => ({
        kind: row.kind,
        id: row.id,
        status: row.status,
        line: row.line,
        code: '',
        figure: row.figure,
        since: null,
        title: row.title,
        at: row.at,
        messageKind: row.messageKind,
        text: row.text,
        when: row.when,
        absolute: row.absolute,
        spoken: row.spoken,
        answerIndex: row.answerIndex,
        summaryHtml: renderRichMarkdown(row.text ?? row.title, undefined, true),
      })),
    activityWord: turn?.activityWord,
    activityName: turn?.activityName,
    activityCounts: turn?.activityCounts,
    activityTools: turn?.activityTools,
    activityToolCategories: turn?.activityToolCategories.map((category) => ({
      key: category.key,
      label: category.label,
      count: category.count,
    })),
    files: turn?.files.map((file) => ({
      name: file.name,
      lead: file.lead,
      label: file.label,
      icon: { label: file.icon.label, colour: file.icon.colour },
      path: file.path,
      shownPath: file.shownPath,
      added: file.added,
      removed: file.removed,
      isNew: file.isNew,
      countsUnknown: file.countsUnknown,
    })),
    agents: turn?.agents.map((agent) => ({
      description: agent.description,
      model: agent.model,
      effort: agent.effort,
      state: agent.state,
      stateWord: agent.stateWord,
      since: null,
      hintDetail: agent.hintDetail,
      sessionId: agent.sessionId,
      figures: agent.figures.map((figure) => ({
        metric: figure.metric,
        compactLabel: figure.compactLabel,
        name: figure.name,
        detail: figure.detail,
        added: figure.added,
        removed: figure.removed,
      })),
    })),
    commits: turn?.commits.map((commit) => ({
      kind: commit.kind,
      key: commit.key,
      sha: commit.sha,
      subject: commit.subject,
      repository: null,
      branch: null,
      headKind: null,
      dir: null,
      where: null,
      detail: commit.detail,
      added: commit.added,
      removed: commit.removed,
      at: commit.at,
      absolute: commit.absolute,
      madeBySession: null,
    })),
    errorText: turn?.errorText,
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

export function exportTurn(value: ExportTurn, agent: 'claude' | 'codex', session: string): Turn {
  const prompts = value.blocks.filter((block) => block.kind === 'prompt');
  const opening = prompts.filter(
    (block, index) => block.opening === true || (block.opening === undefined && index === 0),
  );
  const answers = value.blocks.filter((block) => block.kind === 'answer');
  const prompt = opening.map((block) => block.text).join('\n\n');
  const summary = [...answers].reverse().find((block) => !block.notResponse)?.text ?? '';
  const turn: Turn = {
    agent,
    sessionId: session,
    sessionTitle: null,
    promptId: value.key,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    prompt,
    summary,
    answers: answers.map((block) => ({
      text: block.text,
      at: block.at,
      sourceOrder: block.sourceOrder ?? undefined,
      stepsBefore: 0,
      ...(block.notResponse ? { notResponse: block.notResponse } : {}),
    })),
    delegation: value.blocks.some((block) => block.kind === 'assignment')
      ? {
          text: value.blocks
            .filter((block) => block.kind === 'assignment')
            .map((block) => block.text)
            .join('\n\n'),
          complete: true,
        }
      : undefined,
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
      spend: (agent.spend ?? []).map((part) => ({
        model: part.model,
        provider: part.provider,
        contextWindow: part.contextWindow,
        recordedCost: part.recordedCost ?? undefined,
        costBasis: part.costBasis ?? undefined,
        unclassifiedCacheWrite: part.unclassifiedCacheWrite,
        usage: usage(part.usage),
      })),
      spendFound: agent.spendFound ?? false,
      spendPartial: agent.partial,
    })),
    commits: value.commits.map((commit) => ({ ...commit, place: null, dir: null })),
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
    laterPrompts: prompts
      .filter((block) => !opening.includes(block))
      .map((block) => ({
        text: block.text,
        at: block.at,
        sourceOrder: block.sourceOrder ?? undefined,
        stepsBefore: 0,
      })),
    steps: [],
    updates: value.blocks
      .filter((block) => block.kind === 'commentary')
      .map((block) => ({
        kind: 'commentary',
        sourceId: block.key,
        text: block.text,
        at: block.at,
        sourceOrder: block.sourceOrder ?? undefined,
        stepsBefore: 0,
        status: 'done',
      })),
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
  return turn;
}

function turnCard(value: ExportTurn, agent: 'claude' | 'codex', session: string, capturedAt: number): CardView {
  const card = exportCard(toCard(exportTurn(value, agent, session), false, capturedAt));
  card.key = value.key;
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

function exportCompaction(value: ExportCompaction, session: string, firstRequestCacheRead: number | null): Compaction {
  const compaction: Compaction = {
    sessionId: session,
    at: value.at,
    summary: value.summary,
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
  return compaction;
}

function compactionCard(
  value: ExportCompaction,
  session: string,
  firstRequestCacheRead: number | null,
  capturedAt: number,
): CardView {
  const compaction = exportCompaction(value, session, firstRequestCacheRead);
  const card = exportCard(toCompactionCard(compaction, capturedAt));
  card.key = value.key;
  card.summaryHtml ||= '<p>Recorded details</p>';
  return card;
}

export async function projectSessionSite(
  model: SessionExport,
  writer: ExportTransaction,
  assets: ExportSiteAssets,
): Promise<void> {
  const script = assets.script.replace(/<\/script/gi, '<\\/script');
  const scriptHash = createHash('sha256').update(script).digest('base64');
  const stylesheet = await writer.writeAsset('css', assets.stylesheet);
  let sequence = 0;
  const sessions: SiteManifest['sessions'] = [];
  const rows: PanelSessionRow[] = [];
  const stats: Record<string, PanelStat[]> = {};
  const encode = (id: string, json: string) =>
    `<script type="application/octet-stream" id="arc-data-${id}">${Buffer.from(json).toString('base64')}</script>\n`;
  async function* documentChunks(): AsyncGenerator<string> {
    yield `<!DOCTYPE html><html lang="en" data-theme="onedark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'self' 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'"><title>Arc session</title><link rel="stylesheet" href="./${stylesheet}"></head>${staticPageBody('Arc session', 'Review captured sessions in this read-only export.', 'Loading sessions...')}`;
    for (const session of model.sessions) {
      const title = normalizeSessionTitle(session.title) ?? session.title;
      const pages: SitePage[] = [];
      let cards: SiteAsset[] = [];
      let keys: string[] = [];
      let bytes = 0;
      let newestAt = 0;
      const figures: Turn[] = [];
      const compactions: Compaction[] = [];
      const flush = () => {
        if (cards.length) pages.push({ id: `p${pages.length}`, bytes, keys, cards });
        cards = [];
        keys = [];
        bytes = 0;
      };
      for (const spool of session.pages) {
        checkExportCancellation(writer.signal);
        const page = await writer.readSpool<ExportPage>(spool);
        const entries = [
          ...page.turns.map((turn) => ({ at: turn.startedAt, turn })),
          ...page.compactions.map((compaction) => ({ at: compaction.at, compaction })),
        ].sort((a, b) => b.at - a.at);
        for (const entry of entries) {
          const card =
            'turn' in entry
              ? turnCard(entry.turn, session.agent, session.key, model.capturedAt)
              : compactionCard(entry.compaction, session.key, session.firstRequestCacheRead, model.capturedAt);
          newestAt = Math.max(newestAt, card.endedAt ?? card.startedAt);
          card.sessionTitle = title;
          if ('compaction' in entry)
            compactions.push(
              exportCompaction({ ...entry.compaction, summary: '' }, session.key, session.firstRequestCacheRead),
            );
          if ('turn' in entry) {
            const numeric = exportTurn({ ...entry.turn, blocks: [] }, session.agent, session.key);
            figures.push(numeric);
            const links = entry.turn.relationships
              .map((key) => model.relationships.find((edge) => edge.key === key))
              .filter((edge) => !!edge);
            for (const edge of links) {
              const existing = entry.turn.agents.findIndex((agent) => agent.relationships?.includes(edge.key));
              if (edge.kind === 'subagent' && existing >= 0 && card.agents?.[existing]) {
                card.agents[existing].sessionId = edge.to;
                if (edge.coverage === 'partial')
                  card.agents[existing].hintDetail = [
                    card.agents[existing].hintDetail,
                    `Work is not included: ${edge.reason ?? 'unresolved'}.`,
                  ]
                    .filter(Boolean)
                    .join(' ');
                continue;
              }
              const target = model.sessions.find((candidate) => candidate.key === edge.to);
              const child = {
                kind: edge.kind === 'dispatched' ? ('dispatch' as const) : ('subagent' as const),
                description:
                  target?.title ??
                  `${edge.label ? edge.label + '. ' : ''}Work is not included: ${edge.reason ?? 'unresolved'}.`,
                model: null,
                effort: null,
                state: 'done' as const,
                stateWord: '',
                since: null,
                hintDetail: '',
                sessionId: edge.to,
                figures: [],
              };
              if (edge.kind === 'dispatched') (card.dispatched ??= []).push(child);
              else (card.agents ??= []).push(child);
            }
          }
          const json = exportScriptJson({
            card,
            blocks: 'turn' in entry ? entry.turn.blocks : [{ text: entry.compaction.summary }],
            relationships: 'turn' in entry ? entry.turn.relationships : [],
          });
          const size = Buffer.byteLength(json);
          if (
            cards.length &&
            (cards.length >= EXPORT_LIMITS.initialCards || bytes + size > EXPORT_LIMITS.retainedBytes)
          )
            flush();
          const id = `d${(++sequence).toString(36)}`;
          cards.push({ id, bytes: size });
          keys.push(card.key);
          bytes += size;
          yield encode(id, json);
        }
      }
      flush();
      sessions.push({ ...session, pages });
      rows.push({
        id: session.key,
        label: title,
        fullLabel: session.title,
        agent: session.agent === 'codex' ? 'Codex' : 'Claude',
        agentKey: session.agent,
        persisted: true,
        at: newestAt,
        relative: formatRelative(newestAt, model.capturedAt),
        when: new Date(newestAt).toLocaleString(),
      });
      const total = session.numbers.combined;
      stats[session.key] = sessionStats(figures, compactions).filter(
        (stat) => stat.metric !== 'cost',
      ) as unknown as PanelStat[];
      if (total.dollars !== null && total.dollars > 0)
        stats[session.key].unshift({
          kind: 'plain',
          metric: 'cost',
          label: `${formatCost(total.dollars)}${total.partial ? '+' : ''}`,
          compactLabel: `${formatCost(total.dollars)}${total.partial ? '+' : ''}`,
          dollars: total.dollars,
          partial: total.partial,
          detail: `Estimated total. Main agent: ${formatCost(session.numbers.main.dollars)}. Delegated work: ${formatCost(session.numbers.delegated.dollars)}.${total.partial ? ' Recorded usage is incomplete.' : ''}`,
        });
    }
    const rail = railSessions(
      rows,
      new Map(),
      new Map(rows.map((row) => [row.id, row.at])),
      new Map(),
      new Set(),
      model.root,
      new Set(),
      new Map(),
      stats as unknown as Parameters<typeof railSessions>[8],
      {},
      {},
      Object.fromEntries(model.sessions.map((session) => [session.key, session.numbers.combined])),
      new Map(),
      model.capturedAt,
    );
    const manifest: SiteManifest = { ...model, sessions, rows, stats, rail: rail.map((row) => ({ ...row })) };
    yield encode('manifest', exportScriptJson(manifest));
    yield `<script>${script}</script></body></html>`;
  }
  await writer.writeIndexChunks(documentChunks());
}
