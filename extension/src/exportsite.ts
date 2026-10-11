import { EXPORT_LIMITS } from './exportlimits';
import { checkExportCancellation, type ExportTransaction } from './exportwriter';
import type {
  SessionExport,
  ExportTurn,
  ExportCompaction,
  ExportUsage,
  ExportPage,
  ExportCostPart,
} from './exportdata';
import type { SiteAsset, SiteManifest, SitePage } from './webview/export-model';
import {
  isCacheLifetime,
  normalizeSessionTitle,
  type Turn,
  type TurnUsage,
  type Compaction,
  type TurnUsagePart,
  normalizeFsPath,
} from './transcript';
import {
  toCard,
  toCompactionCard,
  sessionStats,
  sessionCostProjection,
  dispatchedAgentCard,
  dispatchedChip,
  priceDispatchedParts,
  statusOf,
  type SessionCostUsage,
  type DispatchedTurnCost,
} from './turncard';
import { reduceChildArtifacts, childToolCalls, type ChildArtifacts } from './childartifacts';
import { heaviestModel, type AgentSpend } from './agentspend';
import { validRate } from './outputrate';
import { sameCommitSha } from './domain/commit-sha';
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
    at: value.kind === 'compaction' ? value.at : undefined,
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
      .filter((row) => ['message', 'ask', 'step', 'run'].includes(row.kind))
      .map(function activityRow(row): import('./webview/payload-contracts').ActivityRow {
        return {
          kind: row.kind,
          id: row.id,
          status: row.status,
          line: row.line,
          code: row.code,
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
          name: row.name,
          count: row.count,
          failed: row.failed,
          earlier: row.earlier,
          earlierLine: row.earlierLine,
          mix: row.mix,
          label: row.label,
          hintDetail: row.hintDetail,
          inFlight: false,
          steps: row.steps?.map(activityRow),
          ...(row.kind === 'message'
            ? { summaryHtml: renderRichMarkdown(row.text ?? row.title, undefined, true) }
            : {}),
        };
      }),
    activityWord: turn?.activityWord,
    activityName: turn?.activityName,
    activityCounts: turn?.activityCounts,
    activityTools: turn?.activityTools,
    toolTally: turn?.toolTally,
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
      identity: file.identity,
      shownPath: file.shownPath,
      added: file.added,
      removed: file.removed,
      isNew: file.isNew,
      countsUnknown: file.countsUnknown,
    })),
    agents: turn?.agents.map((agent) => ({
      kind: agent.kind,
      files: agent.files?.map((file) => ({
        name: file.name,
        lead: file.lead,
        label: file.label,
        icon: { label: file.icon.label, colour: file.icon.colour },
        path: file.path,
        identity: file.identity,
        shownPath: file.shownPath,
        added: file.added,
        removed: file.removed,
        isNew: file.isNew,
        countsUnknown: file.countsUnknown,
      })),
      commits: agent.commits?.map((commit) => ({
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
        paths: figure.paths,
        fileIdentities: figure.fileIdentities,
        shas: figure.shas,
        record: figure.record as import('./webview/payload-contracts').WireAgentFigure['record'],
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
      focusable: chip.focusable,
      warnings: chip.warnings,
      detailList: chip.detailList?.entries ? chip.detailList : undefined,
    })),
  };
}

function sessionCostUsage(part: ExportCostPart): SessionCostUsage & TurnUsagePart {
  return {
    role: part.role,
    scopeId: part.scope ?? undefined,
    model: part.model,
    provider: part.provider,
    contextWindow: part.contextWindow,
    contextBand: part.contextBand,
    inferenceClass: part.inferenceClass ?? null,
    serviceTier: part.serviceTier,
    recordedCost: part.recordedCost ?? undefined,
    costBasis: part.costBasis ?? undefined,
    unclassifiedCacheWrite: part.unclassifiedCacheWrite,
    incomplete: part.incomplete,
    ...(part.requestCountExact ? {} : { requestCountExact: false as const }),
    ...(part.scope?.startsWith('invocation:') ? { linkedInvocationId: part.scope.slice('invocation:'.length) } : {}),
    ...(part.estimated ? { compactionEstimate: true as const } : {}),
    ...(part.compactionUsage ? { compactionUsage: true as const } : {}),
    ...(part.origin === 'claude-cost-state' || part.origin === 'claude-advisor' ? { usageOrigin: part.origin } : {}),
    usage: usage(part.usage),
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
      stepsBefore: block.stepsBefore ?? 0,
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
      ...(file.identity ? { identity: file.identity } : {}),
      added: file.added ?? 0,
      removed: file.removed ?? 0,
      isNew: file.isNew,
      edits: [],
      ...(file.countsUnknown || file.added === null || file.removed === null ? { countsUnknown: true as const } : {}),
      ...(file.reason ? { unknownReason: file.reason } : {}),
    })),
    agents: value.agents.map((agent) => ({
      id: agent.key,
      description: agent.description,
      agentType: agent.agentType,
      model: agent.model,
      ...(agent.ownModel ? { ownModel: agent.ownModel } : {}),
      ...(agent.outputRate ? { outputRate: agent.outputRate } : {}),
      ...(agent.outputRateModel ? { outputRateModel: agent.outputRateModel } : {}),
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
        usageParts: [sessionCostUsage(part)],
      })),
      spendFound: agent.spendFound ?? false,
      spendPartial: agent.partial,
      ...(agent.artifacts
        ? {
            artifacts: {
              ...agent.artifacts,
              revision: 'capture',
              files: agent.artifacts.files.map((file) => ({
                path: file.path,
                ...(file.identity ? { identity: file.identity } : {}),
                added: file.added ?? 0,
                removed: file.removed ?? 0,
                isNew: file.isNew,
                ...(file.countsUnknown || file.added === null || file.removed === null
                  ? { countsUnknown: true as const }
                  : {}),
                ...(file.countsPartial ? { countsPartial: true as const } : {}),
                ...(file.reason ? { unknownReason: file.reason } : {}),
              })),
            },
          }
        : {}),
    })),
    commits: value.commits.map((commit) => ({ ...commit, place: null, dir: null })),
    usage: usage(value.usage),
    usageParts: value.usageParts.map(sessionCostUsage),
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
    outputRateModel: value.outputRateModel,
    toolUses: value.activity.calls,
    toolCounts: value.activity.counts,
    toolTally: value.activity.tools ?? {},
    laterPrompts: prompts
      .filter((block) => !opening.includes(block))
      .map((block) => ({
        text: block.text,
        at: block.at,
        sourceOrder: block.sourceOrder ?? undefined,
        stepsBefore: block.stepsBefore ?? 0,
      })),
    steps: (value.activity.steps ?? []).map(({ fullDetail, ...step }) => {
      if (fullDetail !== undefined) Object.defineProperty(step, 'fullDetail', { value: fullDetail });
      return step;
    }),
    updates: value.blocks
      .filter((block) => block.kind === 'commentary')
      .map((block) => ({
        kind: 'commentary',
        sourceId: block.key,
        text: block.text,
        at: block.at,
        sourceOrder: block.sourceOrder ?? undefined,
        stepsBefore: block.stepsBefore ?? 0,
        status: 'done',
      })),
    stepCount: value.activity.calls,
    stepKinds: value.activity.categories,
    failedOrdinals: value.activity.failedOrdinals ?? [],
    skillUses: [],
    skillUseCount: 0,
    failures: [],
    interrupted: value.interrupted,
    finished: value.finished,
    error: value.error,
  };
  return turn;
}

function turnCard(
  value: ExportTurn,
  agent: 'claude' | 'codex',
  session: string,
  capturedAt: number,
  restored = exportTurn(value, agent, session),
  dispatched: readonly DispatchedTurnCost[] = [],
): CardView {
  const card = exportCard(toCard(restored, false, capturedAt, [], null, false, new Set(), dispatched));
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

interface SessionAgentFacts {
  spend: AgentSpend;
  newest: number | null;
  state: 'done' | 'failed' | 'interrupted' | 'open';
  dispatchOwners: Map<string, string>;
}

// Read one spooled page at a time and retain child-row figures without message or command bodies.
async function sessionAgentFacts(
  model: SessionExport,
  writer: ExportTransaction,
): Promise<Map<string, SessionAgentFacts>> {
  const facts = new Map<string, SessionAgentFacts>();
  const edges = new Map(model.relationships.map((edge, index) => [edge.key, { edge, index }]));
  for (const session of model.sessions) {
    let artifacts: ChildArtifacts = { files: [], commits: [], complete: true, revision: session.provenance.sha256 };
    const commits: Turn['commits'] = [];
    let newest: number | null = null;
    let state: SessionAgentFacts['state'] = 'open';
    let effort: string | null = null;
    let count = 0;
    const rate = { output: 0, milliseconds: 0 };
    let rateModel: string | undefined;
    let rateQualified = true;
    const failedTools: Record<string, number> = Object.create(null);
    const launches = new Map<string, { turn: string; at: number; index: number }>();
    for (const spool of session.pages) {
      checkExportCancellation(writer.signal);
      const page = await writer.readSpool<ExportPage>(spool);
      for (const value of page.turns) {
        for (const key of value.relationships) {
          const receipt = edges.get(key);
          if (!receipt || receipt.edge.kind !== 'dispatched' || !receipt.edge.to) continue;
          const owner = launches.get(receipt.edge.to);
          if (!owner || value.startedAt < owner.at || (value.startedAt === owner.at && receipt.index < owner.index))
            launches.set(receipt.edge.to, { turn: value.key, at: value.startedAt, index: receipt.index });
        }
        const turn = exportTurn(
          { ...value, blocks: [], activity: { ...value.activity, steps: [] } },
          session.agent,
          session.key,
        );
        const prior = {
          files: artifacts.files.map((file) => ({
            ...file,
            edits: [],
            ...(file.countsPartial ? { countsUnknown: true as const } : {}),
          })),
          commits,
          toolTally: artifacts.tools,
          startedAt: artifacts.startedAt,
          endedAt: artifacts.endedAt,
        };
        const merged = reduceChildArtifacts(
          { turns: [prior, turn] },
          {
            revision: artifacts.revision,
            complete:
              artifacts.complete &&
              (value.finished || value.interrupted || !!value.error) &&
              value.filesComplete !== false,
            pathKey: normalizeFsPath,
            sameCommit: sameCommitSha,
          },
        );
        const failures = (artifacts.failed?.count ?? 0) + value.activity.failures;
        for (const [name, amount] of Object.entries(value.activity.failedTools ?? {}))
          failedTools[name] = (failedTools[name] ?? 0) + amount;
        artifacts = { ...merged, ...(failures ? { failed: { count: failures, byTool: { ...failedTools } } } : {}) };
        if (!value.interrupted && value.outputRate) {
          if (
            !value.outputRateModel ||
            !validRate(value.outputRate) ||
            (rateModel && rateModel !== value.outputRateModel)
          )
            rateQualified = false;
          else {
            rateModel = value.outputRateModel;
            rate.output += value.outputRate.output;
            rate.milliseconds += value.outputRate.milliseconds;
          }
        }
        count++;
        if (newest === null || value.startedAt > newest) {
          newest = value.startedAt;
          state =
            value.finished || value.interrupted || value.error
              ? (statusOf(turn, false, model.capturedAt) as 'done' | 'failed' | 'interrupted')
              : 'open';
          effort = value.effort;
        }
        for (const commit of turn.commits)
          if (!commits.some((held) => sameCommitSha(held.sha, commit.sha))) commits.push(commit);
      }
    }
    if (count > 1) artifacts.turnCount = count;
    else delete artifacts.turnCount;
    const models = session.numbers.parts
      .filter((part) => part.origin !== 'claude-cost-state')
      .map((part) => ({
        ...sessionCostUsage(part),
        usageParts: [sessionCostUsage(part)],
      }));
    facts.set(session.key, {
      newest,
      state,
      dispatchOwners: new Map([...launches].map(([key, value]) => [key, value.turn])),
      spend: {
        models,
        ownModel: session.agent === 'claude' ? heaviestModel(models.filter((part) => part.role === 'main')) : undefined,
        found: true,
        partial: session.numbers.coverage.usage !== 'complete' || session.numbers.combined.partial,
        effort,
        artifacts,
        commits,
        ...(rateQualified && rateModel && rate.output > 0 && validRate(rate)
          ? { outputRate: rate, outputRateModel: rateModel }
          : {}),
      },
    });
  }
  const combined = new Map<string, SessionAgentFacts>();
  for (const [key, own] of facts) {
    const visited = new Set([key]);
    const pending = [key];
    let incomplete = false;
    for (let index = 0; index < pending.length; index++) {
      for (const edge of model.relationships.filter(
        (edge) => edge.from === pending[index] && edge.ownership === 'delegated',
      )) {
        if (!edge.to || edge.coverage !== 'complete') incomplete = true;
        if (edge.to && !visited.has(edge.to)) {
          visited.add(edge.to);
          pending.push(edge.to);
        }
      }
    }
    const descendants = pending.map((id) => facts.get(id)).filter((value) => value !== undefined);
    const commits: Turn['commits'] = [];
    for (const descendant of descendants)
      for (const commit of descendant.spend.commits ?? [])
        if (!commits.some((held) => sameCommitSha(held.sha, commit.sha))) commits.push(commit);
    const artifacts = reduceChildArtifacts(
      {
        turns: descendants.map((value) => ({
          files: (value.spend.artifacts?.files ?? []).map((file) => ({
            ...file,
            edits: [],
            ...(file.countsPartial ? { countsUnknown: true as const } : {}),
          })),
          commits: value.spend.commits ?? [],
          toolTally: value.spend.artifacts?.tools,
        })),
      },
      {
        revision: own.spend.artifacts!.revision,
        complete: !incomplete && descendants.every((value) => value.spend.artifacts?.complete),
        pathKey: normalizeFsPath,
        sameCommit: sameCommitSha,
      },
    );
    const failed = descendants.reduce((count, value) => count + (value.spend.artifacts?.failed?.count ?? 0), 0);
    const failedTools: Record<string, number> = Object.create(null);
    for (const descendant of descendants)
      for (const [name, amount] of Object.entries(descendant.spend.artifacts?.failed?.byTool ?? {}))
        failedTools[name] = (failedTools[name] ?? 0) + amount;
    combined.set(key, {
      ...own,
      spend: {
        ...own.spend,
        commits,
        artifacts: {
          ...artifacts,
          ...(failed ? { failed: { count: failed, byTool: { ...failedTools } } } : {}),
          startedAt: own.spend.artifacts?.startedAt,
          endedAt: own.spend.artifacts?.endedAt,
          turnCount: own.spend.artifacts?.turnCount,
        },
      },
    });
  }
  return combined;
}

function exportCompaction(
  value: ExportCompaction,
  session: string,
  firstRequestCachedTokens: number | null,
): Compaction {
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
    postCompactionCacheRead: value.postCompactionCacheRead ?? undefined,
    retainedContext: value.retainedContext ?? undefined,
    contextWindow: value.contextWindow,
    inferenceClass: value.inferenceClass,
    serviceTier: value.serviceTier,
    firstRequestCachedTokens: firstRequestCachedTokens ?? undefined,
  };
  return compaction;
}

function compactionCard(
  value: ExportCompaction,
  session: string,
  firstRequestCachedTokens: number | null,
  capturedAt: number,
): CardView {
  const compaction = exportCompaction(value, session, firstRequestCachedTokens);
  const card = exportCard(toCompactionCard(compaction, capturedAt));
  card.key = value.key;
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
  const rows: (PanelSessionRow & { agentRun: boolean })[] = [];
  const stats: Record<string, PanelStat[]> = {};
  const sources = new Map(model.sessions.map((session) => [session.key, session]));
  const childFacts = await sessionAgentFacts(model, writer);
  const countedDispatches = new Set<string>();
  const encode = (id: string, json: string) =>
    `<script type="application/octet-stream" id="arc-data-${id}">${Buffer.from(json).toString('base64')}</script>\n`;
  async function* documentChunks(): AsyncGenerator<string> {
    yield `<!DOCTYPE html><html lang="en" data-theme="onedark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'self' 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'"><title>Arc session</title><link rel="stylesheet" href="./${stylesheet}"></head>${staticPageBody('Arc session', '', 'Loading sessions...')}`;
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
          const restored = 'turn' in entry ? exportTurn(entry.turn, session.agent, session.key) : null;
          const dispatched: DispatchedTurnCost[] = [];
          if (restored && 'turn' in entry) {
            for (const edge of model.relationships.filter((edge) => entry.turn.relationships.includes(edge.key))) {
              const facts = edge.to ? childFacts.get(edge.to) : undefined;
              const target = edge.to ? sources.get(edge.to) : undefined;
              if (!facts || !target) continue;
              const existing = entry.turn.agents.findIndex((agent) => agent.relationships?.includes(edge.key));
              // Graph keys keep printed Claude costs matched to their included child.
              if (existing >= 0) restored.agents[existing].id = edge.to;
              if (edge.kind === 'subagent' && existing >= 0) {
                const agent = restored.agents[existing];
                agent.spend = facts.spend.models;
                agent.spendFound = true;
                agent.spendPartial = facts.spend.partial;
                agent.ownModel = facts.spend.ownModel ?? undefined;
                agent.artifacts = facts.spend.artifacts
                  ? {
                      ...facts.spend.artifacts,
                      complete: facts.spend.artifacts.complete && agent.artifacts?.complete !== false,
                    }
                  : undefined;
                agent.commits = facts.spend.commits;
                agent.outputRate = facts.spend.outputRate;
                agent.outputRateModel = facts.spend.outputRateModel;
                agent.effort ??= facts.spend.effort;
                agent.startedAt ??= facts.spend.artifacts?.startedAt ?? null;
                agent.toolUses ??= childToolCalls(facts.spend.artifacts);
                if (['running', 'async_launched', 'launched'].includes(agent.status) && facts.state !== 'open')
                  agent.status = facts.state === 'done' ? 'completed' : facts.state;
                if (
                  agent.durationMs === null &&
                  facts.state !== 'open' &&
                  facts.spend.artifacts?.startedAt != null &&
                  facts.spend.artifacts?.endedAt != null
                )
                  agent.durationMs = Math.max(0, facts.spend.artifacts.endedAt - facts.spend.artifacts.startedAt);
              }
              if (
                edge.kind === 'dispatched' &&
                childFacts.get(session.key)?.dispatchOwners.get(edge.to!) === entry.turn.key &&
                !countedDispatches.has(`${session.key}:${edge.to}`)
              ) {
                countedDispatches.add(`${session.key}:${edge.to}`);
                dispatched.push({
                  sessionId: edge.to!,
                  name: target.title,
                  costs: priceDispatchedParts(
                    target.numbers.parts
                      .filter((part) => part.origin !== 'claude-cost-state')
                      .map((part) => ({
                        ...sessionCostUsage(part),
                        ...(part.role === 'main' ? { own: true as const } : {}),
                      })),
                  ),
                  short: target.numbers.coverage.usage !== 'complete' || edge.coverage === 'partial',
                  ownSettledAt: facts.state === 'open' ? null : facts.newest,
                });
              }
            }
          }
          const card =
            'turn' in entry
              ? turnCard(entry.turn, session.agent, session.key, model.capturedAt, restored!, dispatched)
              : compactionCard(entry.compaction, session.key, session.firstRequestCachedTokens, model.capturedAt);
          newestAt = Math.max(newestAt, card.endedAt ?? card.startedAt);
          card.sessionTitle = title;
          if ('compaction' in entry)
            compactions.push(
              exportCompaction({ ...entry.compaction, summary: '' }, session.key, session.firstRequestCachedTokens),
            );
          if ('turn' in entry) {
            const numeric = exportTurn(
              { ...entry.turn, blocks: [], activity: { ...entry.turn.activity, steps: [] } },
              session.agent,
              session.key,
            );
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
              const facts = edge.to ? childFacts.get(edge.to) : undefined;
              const child =
                facts && target
                  ? exportCard({
                      ...toCard(restored!, false, model.capturedAt),
                      agents: [
                        dispatchedAgentCard(
                          target.key,
                          target.title,
                          facts.spend,
                          facts.state,
                          facts.spend.artifacts?.startedAt ?? null,
                          facts.spend.artifacts?.endedAt ?? null,
                          childToolCalls(facts.spend.artifacts) ?? 0,
                          [],
                          model.capturedAt,
                          target.agent,
                        ),
                      ],
                    }).agents![0]
                  : {
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
              child.kind = edge.kind === 'dispatched' ? 'dispatch' : 'subagent';
              if (edge.kind === 'dispatched') (card.dispatched ??= []).push(child);
              else (card.agents ??= []).push(child);
            }
            if (card.dispatched?.length)
              card.chips!.push(dispatchedChip(card.dispatched as Parameters<typeof dispatchedChip>[0]));
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
        agentRun: session.agentRun,
        at: newestAt,
        relative: formatRelative(newestAt, model.capturedAt),
        when: new Date(newestAt).toLocaleString(),
      });
      const total = session.numbers.combined;
      stats[session.key] = sessionStats(figures, compactions).filter(
        (stat) => stat.metric !== 'cost',
      ) as unknown as PanelStat[];
      const usageMissing = session.numbers.coverage.usage !== 'complete';
      const mainMissing = session.numbers.parts.some((part) => part.role === 'main' && part.incomplete);
      const delegatedParts = session.numbers.parts.filter((part) => part.role === 'delegated');
      const delegatedScopeIds = new Set<string>();
      for (const part of delegatedParts) {
        const source = part.scope ? sources.get(part.scope) : undefined;
        if (part.scope && (part.incomplete || (source && source.numbers.coverage.usage !== 'complete')))
          delegatedScopeIds.add(part.scope);
      }
      const missingLinks =
        session.coverage.relationships === 'partial' ||
        model.relationships.some(
          (edge) => edge.from === session.key && edge.ownership === 'delegated' && edge.coverage === 'partial',
        );
      const delegatedMissing =
        missingLinks || delegatedScopeIds.size > 0 || delegatedParts.some((part) => part.incomplete);
      // Unattributed missing usage qualifies every retained scope that it can affect.
      const unknownCoverage = usageMissing;
      if (missingLinks || unknownCoverage)
        for (const part of delegatedParts) if (part.scope) delegatedScopeIds.add(part.scope);
      const projection = sessionCostProjection(
        session.numbers.parts.map((part) => ({
          ...sessionCostUsage(part),
          agent: (part.scope ? sources.get(part.scope)?.agent : null) ?? session.agent,
        })),
        {
          main: mainMissing || unknownCoverage,
          delegated: delegatedMissing || (unknownCoverage && delegatedParts.length > 0),
          delegatedScopeIds,
        },
        { compactionCount: session.compactionCount },
        session.numbers,
      );
      const cost = projection.stats[0];
      if (cost && total.dollars !== null) {
        stats[session.key].unshift(cost as unknown as PanelStat);
      } else if (total.dollars !== null && total.dollars > 0) {
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
    }
    const rail = railSessions(
      rows,
      new Map(),
      new Map(rows.map((row) => [row.id, row.at])),
      new Map(),
      new Set(model.sessions.filter((session) => session.archived).map((session) => session.key)),
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
