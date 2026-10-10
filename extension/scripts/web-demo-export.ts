import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  costPartOf,
  projectTurn,
  type SessionExport,
  type ExportRelationship,
  type ExportPage,
} from '../src/exportdata.ts';
import { projectSessionSite } from '../src/exportsite.ts';
import { ExportTransaction } from '../src/exportwriter.ts';
import { exportBrowserAssets } from '../src/panelbundle.ts';
import { sessionCostProjection, type SessionCostUsage } from '../src/turncard.ts';
import {
  CAPTURE_TIME,
  ROOT,
  DEMO_SESSION_IDS,
  DEMO_TURNS,
  demoParentEdges,
  demoReaderParents,
} from './readme-fixture.ts';

// Only invented fixture identities enter the downloadable graph.
export async function writeDemoExports(destination: string): Promise<Record<string, string>> {
  const assets = exportBrowserAssets();
  const downloads: Record<string, string> = {};
  const edges: ExportRelationship[] = [
    ...[...demoParentEdges].map(([to, edge], index) => ({
      key: `delegated-${index}`,
      from: edge.parent,
      to,
      kind: edge.relation === 'dispatched' ? ('dispatched' as const) : ('subagent' as const),
      ownership: 'delegated' as const,
      turn: `${edge.parent}-t0`,
      requestedByReader: false,
      coverage: 'complete' as const,
    })),
    ...Object.entries(demoReaderParents).map(([to, from], index) => ({
      key: `reader-${index}`,
      from,
      to,
      kind: 'reader-started' as const,
      ownership: 'navigation' as const,
      turn: `${from}-t0`,
      requestedByReader: true,
      coverage: 'complete' as const,
    })),
  ].filter((edge) => !!DEMO_TURNS[edge.from] && !!DEMO_TURNS[edge.to]);
  const ownParts = (id: string): SessionCostUsage[] =>
    DEMO_TURNS[id].flatMap((turn) => [
      {
        agent: turn.agent,
        model: turn.model,
        provider: turn.provider ?? null,
        contextWindow: turn.contextWindow,
        usage: turn.usage,
        incomplete: !turn.finished,
        role: 'main' as const,
        scopeId: id,
      },
      ...turn.agents
        .filter(
          (agent) =>
            !agent.childSessionId || !edges.some((edge) => edge.from === id && edge.to === agent.childSessionId),
        )
        .flatMap((agent) =>
          agent.spend.map((part) => ({
            ...part,
            agent: turn.agent,
            provider: part.provider ?? null,
            contextWindow: part.contextWindow ?? turn.contextWindow,
            role: 'delegated' as const,
            scopeId: agent.id ?? undefined,
            incomplete: agent.spendPartial || !agent.spendFound,
          })),
        ),
    ]);
  for (const root of DEMO_SESSION_IDS) {
    const reachable = new Set([root]);
    for (let changed = true; changed;) {
      changed = false;
      for (const edge of edges)
        if (reachable.has(edge.from) && !reachable.has(edge.to!)) {
          reachable.add(edge.to!);
          changed = true;
        }
    }
    const relationships = edges.filter((edge) => reachable.has(edge.from));
    const writer = await ExportTransaction.create(destination);
    try {
      const model: SessionExport = {
        version: 1,
        root,
        capturedAt: CAPTURE_TIME,
        sessions: [],
        relationships,
        omissions: [],
        coverage: { text: 'complete', relationships: 'complete', inventory: 'complete' },
        deliberatelyOmitted: [
          'reasoning',
          'raw-tools',
          'commands',
          'patches',
          'attachments',
          'comments',
          'drafts',
          'queued-submissions',
          'live-state',
          'absolute-metadata-paths',
          'resume-commands',
        ],
      };
      for (const id of reachable) {
        const source = DEMO_TURNS[id];
        const page: ExportPage = {
          key: id,
          session: id,
          compactions: [],
          turns: source.map((turn, index) => {
            const links = new Map<string, string[]>();
            const agents = turn.agents.map((agent, agentIndex) => ({
              ...agent,
              toolUseId: agent.toolUseId ?? `demo-agent-${agentIndex}`,
            }));
            for (const agent of agents) {
              const matching = relationships.filter((edge) => edge.from === id && edge.to === agent.childSessionId);
              if (agent.toolUseId && matching.length)
                links.set(
                  agent.toolUseId,
                  matching.map((edge) => edge.key),
                );
            }
            const projected = projectTurn(
              {
                ...turn,
                agents,
                answers: turn.answers.length
                  ? turn.answers
                  : turn.summary
                    ? [{ text: turn.summary, at: turn.endedAt, stepsBefore: turn.stepCount }]
                    : [],
              },
              `${id}-t${index}`,
              { cwd: ROOT },
              model.omissions,
              id,
              links,
            );
            if (index === 0)
              projected.relationships = [
                ...new Set([
                  ...projected.relationships,
                  ...relationships.filter((edge) => edge.from === id).map((edge) => edge.key),
                ]),
              ];
            return projected;
          }),
        };
        const delegated = new Set<string>();
        const visit = (parent: string) => {
          for (const edge of relationships)
            if (edge.from === parent && edge.ownership === 'delegated' && edge.to && !delegated.has(edge.to)) {
              delegated.add(edge.to);
              visit(edge.to);
            }
        };
        visit(id);
        const parts = [
          ...ownParts(id),
          ...[...delegated].flatMap((child) =>
            ownParts(child).map((part) => ({
              ...part,
              role: 'delegated' as const,
              incomplete:
                part.incomplete ||
                relationships.some(
                  (edge) =>
                    edge.ownership === 'delegated' &&
                    edge.to === child &&
                    DEMO_TURNS[edge.from].some((turn) =>
                      turn.agents.some(
                        (agent) => agent.childSessionId === child && (agent.spendPartial || !agent.spendFound),
                      ),
                    ),
                ),
            })),
          ),
        ];
        const price = (role: 'main' | 'delegated') =>
          sessionCostProjection(parts.filter((part) => part.role === role)).total;
        const combined = sessionCostProjection(parts).total;
        model.sessions.push({
          key: id,
          agent: source[0].agent,
          title: source[0].sessionTitle!,
          pages: [await writer.spool(page)],
          turnCount: source.length,
          compactionCount: 0,
          firstRequestCacheRead: null,
          numbers: {
            parts: parts.map((part) => costPartOf(part, part.scopeId)),
            main: price('main'),
            delegated: price('delegated'),
            combined,
            coverage: {
              usage: parts.some((part) => part.incomplete) ? 'partial' : 'complete',
              cost: combined.dollars === null ? 'unpriced' : combined.partial ? 'partial' : 'complete',
            },
          },
          parentOutsideExport: [...edges].some((edge) => edge.to === id && !reachable.has(edge.from)),
          provenance: { sourceBytes: 0, sha256: createHash('sha256').update(JSON.stringify(page)).digest('hex') },
          coverage: {
            text: 'complete',
            relationships: 'complete',
            context: 'recorded',
            changes: page.turns.some((turn) => turn.changes === 'partial') ? 'partial' : 'recorded',
          },
        });
      }
      await projectSessionSite(model, writer, assets);
      const html = (await fs.readFile(path.join(writer.staging, 'index.html'), 'utf8')).replace(
        /<link rel="stylesheet" href="\.\/a-[a-z0-9]+\.css">/,
        `<style>${assets.stylesheet}</style>`,
      );
      const filename = `export-${root}.html`;
      await fs.writeFile(path.join(destination, filename), html);
      downloads[root] = filename;
    } finally {
      await writer.dispose();
    }
  }
  await fs.writeFile(path.join(destination, 'exports.json'), JSON.stringify(downloads, null, 2) + '\n');
  return downloads;
}
