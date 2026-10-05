import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const rail = await import(pathToFileURL(join(root, 'src/domain/rail-filters.mjs')).href);
const { matchSessions } = await import(pathToFileURL(join(root, 'src/domain/session-query.mjs')).href);
const active = rail.RAIL_LENS_WORDS.active;
const unread = rail.RAIL_LENS_WORDS.unread;
const input = rail.RAIL_LENS_WORDS.input;
const sessions = [
  { id: 'unread', label: 'UI', agent: 'Codex', labels: ['ui'], unread: true, status: 'idle' },
  { id: 'waiting', label: 'UI', agent: 'Codex', labels: ['ui'], unread: false, status: 'waiting' },
  { id: 'archived', label: 'UI', agent: 'Codex', labels: ['ui'], unread: true, status: 'idle', archived: true },
  { id: 'agentrun', label: 'UI', agent: 'Codex', labels: ['ui'], unread: true, status: 'running', runByAgent: true },
];
const ids = (query, match) => matchSessions(sessions, query, match).map(({ id }) => id).join(',');
const cases = [
  ['typed-status', () => rail.railQueryLenses(rail.withRailLens(`is:unread label:ui ${active}`, 'input')).join(',') === 'input'],
  ['complete-lens', () => rail.withRailLens(`${unread} label:ui`, 'input') === `${input} label:ui`],
  ['quoted-label', () => rail.toggleRailFilterTerm('label:"release 0.4" cost:>5', 'labels', 'release 0.4') === 'cost:>5'],
  ['negated-label', () => rail.railFilterTermNegated('-label:ui', 'labels', 'ui')],
  ['combined-terms', () => rail.withRailLens(`${active} label:ui cost:>5`, null) === 'label:ui cost:>5'],
  ['partial-lens', () => rail.withRailLens('is:unread label:ui', null) === 'is:unread label:ui'],
  ['ambiguous-lenses', () => rail.railQueryHeldLens(`${active} is:unread`) === null],
  ['typed-cross-product', () => rail.RAIL_LENSES.every((lens) => ['is:active', 'is:unread', 'is:input'].every((typed) => {
    const set = rail.withRailLens(`${typed} label:ui`, lens);
    return rail.railQueryHeldLens(set) === lens && rail.withoutRailLenses(set) === 'label:ui';
  }))],
  ['ambiguous-reset', () => rail.withRailLens(`is:input ${unread} label:ui`, null) === 'label:ui'],
  ['ambiguous-switch', () => rail.pressRailLens(`is:input ${unread} label:ui`, 'unread') === `${unread} label:ui`],
  ['pressed-toggle', () => rail.pressRailLens(`${input} label:ui`, 'input') === 'label:ui'],
  ['unknown-status', () => rail.withRailLens('is:done label:ui', 'input') === `${input} is:done label:ui`],
  ['negated-unread', () => {
    const query = rail.pressRailLens('-is:unread label:ui', 'unread');
    return query === `${unread} label:ui` && ids(query, 'all') === 'unread' && ids(query, 'any') === 'unread,waiting';
  }],
  ['quoted-negated-input', () => {
    const query = rail.pressRailLens('-is:"input" label:ui', 'input');
    return query === `${input} label:ui` && ids(query, 'all') === 'waiting' && ids(query, 'any') === 'unread,waiting';
  }],
  ['combined-opposing-status', () => {
    const query = rail.pressRailLens('is:unread -is:input label:ui', 'input');
    return query === `${input} label:ui` && ids(query, 'all') === 'waiting' && ids(query, 'any') === 'unread,waiting';
  }],
  ['positive-exclusions', () => {
    const query = rail.pressRailLens('is:archived is:agentrun label:ui', 'unread');
    return query === `${unread} label:ui` && ids(query, 'all') === 'unread' && ids(query, 'any') === 'unread,waiting';
  }],
  ['read-conflicts-unread', () => {
    const query = rail.pressRailLens('is:read label:ui', 'unread');
    return query === `${unread} label:ui` && ids(query, 'all') === 'unread';
  }],
  ['quoted-read-conflicts-unread', () => {
    const query = rail.pressRailLens('is:"read" label:ui', 'unread');
    return query === `${unread} label:ui` && ids(query, 'all') === 'unread';
  }],
  ['running-conflicts-input', () => {
    const query = rail.pressRailLens('is:running label:ui', 'input');
    return query === `${input} label:ui` && ids(query, 'all') === 'waiting';
  }],
];
console.log(JSON.stringify({ checks: cases.map(([id, test], index) => ({ id, role: index ? 'symptom' : 'normal', pass: Boolean(test()) })) }));
