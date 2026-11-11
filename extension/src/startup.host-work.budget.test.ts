// @module-tag subprocess
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { beforeAll, test } from 'vitest';
import {
  initializeBudgetHost,
  hostWorkSkip,
  hostCoverage,
  coverageSession,
  BUDGET_FILE,
  HOST_WORK_FILE,
} from '../test/budgethostfixture.ts';
import type { BudgetRow } from '../test/budgethostfixture.ts';

beforeAll(async () => {
  if (!hostWorkSkip) await initializeBudgetHost(true);
});

test('host work per listed session stays within its recorded counts', async ({ skip }) => {
  if (hostWorkSkip) skip(hostWorkSkip);
  const locations = new Map<string, Map<number, string>>();
  const low = await hostCoverage(80, coverageSession, locations);
  const high = await hostCoverage(280, coverageSession, locations);
  const delta = high.listed - low.listed;
  assert.equal(delta, 200);
  const measured: Record<string, { value: number; functions: Record<string, number> }> = {};
  for (const [event, functions] of Object.entries(high.events)) {
    const before = low.events[event];
    const growth = [...new Set([...functions.keys(), ...before.keys()])]
      .map((name) => ({ name, growth: ((functions.get(name) ?? 0) - (before.get(name) ?? 0)) / delta }))
      .sort((a, b) => b.growth - a.growth || a.name.localeCompare(b.name));
    measured[event] = {
      value: Number(growth.reduce((sum, fn) => sum + fn.growth, 0).toFixed(6)),
      functions: Object.fromEntries(growth.map(({ name, growth }) => [name, growth])),
    };
  }
  const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
  const rows: Record<string, BudgetRow> = budget.hostWork;
  if (process.env.ARC_UPDATE_HOST_WORK === '1') {
    for (const [event, sample] of Object.entries(measured)) rows[event].budget = sample.value;
    fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`);
    fs.writeFileSync(
      HOST_WORK_FILE,
      `${JSON.stringify(
        Object.fromEntries(Object.entries(measured).map(([event, sample]) => [event, sample.functions])),
        null,
        2,
      )}\n`,
    );
  }
  const recorded: Record<string, Record<string, number>> = JSON.parse(fs.readFileSync(HOST_WORK_FILE, 'utf8'));
  const failures: string[] = [];
  for (const event of new Set([...Object.keys(rows), ...Object.keys(measured)])) {
    const sample = measured[event];
    const row = rows[event];
    if (sample && row && Math.abs(sample.value - row.budget) <= row.margin) continue;
    const previous = recorded[event] ?? {};
    const current = sample?.functions ?? {};
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(current)])]
      .map((name) => ({ name, old: previous[name] ?? 0, value: current[name] ?? 0 }))
      .filter((fn) => fn.old !== fn.value)
      .sort((a, b) => Math.abs(b.value - b.old) - Math.abs(a.value - a.old) || a.name.localeCompare(b.name));
    failures.push(
      `${event}: measured ${sample?.value ?? 'nothing'} block executions per added session, recorded ${row?.budget ?? 'no row'} with margin ${row?.margin ?? 0}. ${row?.reason ?? ''} Lower the row in scripts/test-budget.json after a reduction. Investigate growth before changing a row.\n${changed.map((fn) => `${fn.name}: ${fn.old} -> ${fn.value} (difference ${Number((fn.value - fn.old).toFixed(6))})`).join('\n')}`,
    );
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});
