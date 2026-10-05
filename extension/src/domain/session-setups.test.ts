import { test } from 'vitest';
import assert from 'node:assert';
import {
  RECENT_SETUP_LIMIT,
  RECENT_SETUP_VISIBLE,
  missingSetupValue,
  normalizePinnedSetups,
  pinValues,
  sameValues,
  unpinId,
  visibleRecents,
  type CompleteSetupValues,
  type PinnedSetup,
  type SetupCatalogAgent,
} from './session-setups.ts';

const OPUS: CompleteSetupValues = { agent: 'claude', model: 'opus', effort: 'high', permissionMode: 'auto' };
const SONNET: CompleteSetupValues = { agent: 'claude', model: 'sonnet', effort: 'medium', permissionMode: 'auto' };
const DEFAULTS: CompleteSetupValues = { agent: 'claude', model: '', effort: '', permissionMode: '' };
const CATALOG: SetupCatalogAgent[] = [
  {
    value: 'claude',
    models: [
      { value: '', efforts: [{ value: '' }] },
      { value: 'opus', efforts: [{ value: '' }, { value: 'high' }] },
      { value: 'sonnet', efforts: [{ value: '' }, { value: 'medium' }] },
    ],
    permissions: [{ value: '' }, { value: 'auto' }],
  },
];
const pinned = (id: string, values: CompleteSetupValues): PinnedSetup => ({ id, ...values });

test('stored pins reject malformed values and repeated ids without checking current catalogs', () => {
  const retired = { ...OPUS, model: 'retired', effort: 'retired-effort', permissionMode: 'retired-permission' };
  assert.deepEqual(normalizePinnedSetups(null), []);
  assert.deepEqual(
    normalizePinnedSetups([
      null,
      'bad',
      { id: 'first', ...OPUS },
      { id: 'first', ...SONNET },
      { id: 'bad-agent', ...OPUS, agent: 'other' },
      { id: 'bad-model', ...OPUS, model: 3 },
      { id: 'bad-effort', ...OPUS, effort: undefined },
      { id: 'bad-permission', ...OPUS, permissionMode: 'x'.repeat(201) },
      { id: ' ', ...OPUS },
      { id: 'x'.repeat(65), ...OPUS },
      { id: 'retired', ...retired },
    ]),
    [pinned('first', OPUS), pinned('retired', retired)],
  );
});

test('empty setup values remain valid choices', () => {
  assert.deepEqual(normalizePinnedSetups([pinned('default', DEFAULTS)]), [pinned('default', DEFAULTS)]);
  assert.equal(missingSetupValue(DEFAULTS, CATALOG), null);
  assert.equal(sameValues(DEFAULTS, { ...DEFAULTS, permissionMode: 'auto' }), false);
});

test('pinning equal values reuses one record and unpinning removes only its id', () => {
  const one = pinValues([], OPUS, 'one');
  assert.deepEqual(pinValues(one, OPUS, 'two'), one);
  const two = pinValues(one, SONNET, 'two');
  assert.deepEqual(two, [pinned('one', OPUS), pinned('two', SONNET)]);
  assert.deepEqual(unpinId(two, 'one'), [pinned('two', SONNET)]);
  assert.deepEqual(unpinId(two, 'absent'), two);
});

test('a missing catalog value keeps the stored pin and names the missing field', () => {
  assert.equal(missingSetupValue({ ...OPUS, agent: null }, CATALOG), 'agent');
  assert.equal(missingSetupValue({ ...OPUS, model: 'retired' }, CATALOG), 'model');
  assert.equal(missingSetupValue({ ...OPUS, effort: 'retired' }, CATALOG), 'effort');
  assert.equal(missingSetupValue({ ...OPUS, permissionMode: 'retired' }, CATALOG), 'permission');
  assert.deepEqual(normalizePinnedSetups([pinned('old', { ...OPUS, model: 'retired' })]), [
    pinned('old', { ...OPUS, model: 'retired' }),
  ]);
});

test('recent choices retain ten, show eight, and hide duplicate or unavailable values', () => {
  const recents = Array.from({ length: 12 }, (_, index) => ({ ...OPUS, model: `model-${index}` }));
  const catalog = [
    { ...CATALOG[0], models: recents.map((one) => ({ value: one.model, efforts: [{ value: 'high' }] })) },
  ];
  assert.equal(RECENT_SETUP_LIMIT, 10);
  assert.equal(RECENT_SETUP_VISIBLE, 8);
  assert.deepEqual(visibleRecents(recents, [], null, catalog), recents.slice(0, 8));
  assert.deepEqual(visibleRecents(recents, [], null, [{ ...catalog[0], models: catalog[0].models.slice(10) }]), []);
  assert.deepEqual(visibleRecents([OPUS, SONNET, OPUS, DEFAULTS], [SONNET], OPUS, CATALOG), [DEFAULTS]);
  assert.deepEqual(visibleRecents([OPUS, OPUS, SONNET], [], null, CATALOG), [OPUS, SONNET]);
});
