import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { assert, encoded, readJson, sha } from './core.mjs';
import { limitation, persist } from './live.mjs';

function shuffled(items, seed) {
  return [...items].sort((a, b) => sha(`${seed}:${a.id}`).localeCompare(sha(`${seed}:${b.id}`)));
}

function registeredCells(run) {
  const registration = readJson(path.join(run, 'registration.json'));
  const cells = readJson(path.join(run, 'cells.json'));
  const { cases: registeredCases, requested, cell_order: order } = registration;
  assert(registration.schema === 'arc-portable-run-v1', 'registration schema');
  assert(Array.isArray(registeredCases) && Array.isArray(order) && Array.isArray(cells), 'registration cells');
  assert(
    requested &&
      ['cases', 'models', 'efforts'].every((key) => Array.isArray(requested[key]) && requested[key].length > 0) &&
      Number.isSafeInteger(requested.repeats) &&
      requested.repeats > 0,
    'registration request',
  );
  for (const values of [
    registeredCases.map((item) => item.id),
    requested.cases,
    requested.models,
    requested.efforts,
    order,
  ])
    assert(new Set(values).size === values.length, 'duplicate registration identity');
  assert(
    registeredCases.length === requested.cases.length &&
      registeredCases.every((item, index) => item.id === requested.cases[index]),
    'registered cases differ from request',
  );
  for (const registered of registeredCases) {
    const key = readJson(path.join(run, 'keys', `${registered.id}.json`));
    assert(
      key.case_hash === registered.case_hash &&
        key.item.revision === registered.revision &&
        sha(encoded(key.item)) === registered.key_hash,
      'changed scoring key or case revision',
    );
  }
  const expected = new Set();
  for (const caseId of requested.cases)
    for (const model of requested.models)
      for (const effort of requested.efforts)
        for (let repeat = 1; repeat <= requested.repeats; repeat++)
          expected.add(
            registration.mode === 'demo' && model === 'scripted-demo' && effort === 'none' && repeat === 1
              ? `demo-${caseId}`
              : `${caseId}-${model}-${effort}-${repeat}`,
          );
  assert(order.length === expected.size && order.every((id) => expected.has(id)), 'registered cell order');
  assert(cells.length === order.length, 'missing or extra cells');
  const replyIds = new Set();
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    const registered = registeredCases.find((item) => item.id === cell.case_id);
    assert(cell.id === order[index] && registered, 'cell identity or order');
    assert(
      requested.models.includes(cell.model) &&
        requested.efforts.includes(cell.effort) &&
        Number.isSafeInteger(cell.repeat) &&
        cell.repeat >= 1 &&
        cell.repeat <= requested.repeats &&
        cell.id ===
          (registration.mode === 'demo' && cell.model === 'scripted-demo' && cell.effort === 'none' && cell.repeat === 1
            ? `demo-${cell.case_id}`
            : `${cell.case_id}-${cell.model}-${cell.effort}-${cell.repeat}`),
      'cell condition',
    );
    assert(
      cell.case_hash === registered.case_hash &&
        cell.source_mode === registered.source_mode &&
        cell.family === registered.family &&
        cell.kind === registered.kind,
      'cell case revision or metadata',
    );
    assert(cell.reply_id === sha(`${registration.run_id}:${cell.id}`).slice(0, 16), 'cell reply identity');
    assert(!replyIds.has(cell.reply_id), 'duplicate reply identity');
    replyIds.add(cell.reply_id);
  }
  return { registration, cells };
}

export function worksheet(run) {
  const { registration, cells } = registeredCells(run);
  const replies = cells.filter(
    (cell) =>
      cell.execution?.status === 'completed' && typeof cell.execution.reply === 'string' && cell.execution.reply.trim(),
  );
  return {
    schema: 'arc-review-worksheet-v1',
    run_id: registration.run_id,
    registration_sha256: sha(fs.readFileSync(path.join(run, 'registration.json'))),
    replies: shuffled(
      replies.map((cell) => ({
        id: cell.reply_id,
        case_id: cell.case_id,
        case_hash: cell.case_hash,
        reply_sha256: sha(cell.execution.reply),
        reply: cell.execution.reply,
        matched_key_ids: null,
        novel_valid_findings: null,
        false_claims: null,
        verdict: null,
        false_blocker: null,
      })),
      registration.run_id,
    ),
  };
}

function checkWorksheet(run, candidate, allowInvalidAnswers = false) {
  const expected = worksheet(run);
  const { registration, cells } = registeredCells(run);
  assert(
    candidate.schema === expected.schema &&
      candidate.run_id === expected.run_id &&
      candidate.registration_sha256 === expected.registration_sha256,
    'worksheet identity',
  );
  assert(Array.isArray(candidate.replies) && candidate.replies.length === expected.replies.length, 'worksheet length');
  const reference = new Map(expected.replies.map((reply) => [reply.id, reply]));
  const seen = new Set();
  for (const reply of candidate.replies) {
    const frozen = reference.get(reply.id);
    assert(frozen && !seen.has(reply.id), 'worksheet reply identity');
    seen.add(reply.id);
    for (const key of ['case_id', 'case_hash', 'reply_sha256', 'reply'])
      assert(reply[key] === frozen[key], `worksheet changed ${key}`);
    const keys = readJson(path.join(run, 'keys', `${reply.case_id}.json`));
    const registered = registration.cases.find((item) => item.id === reply.case_id);
    assert(
      registered &&
        registered.case_hash === reply.case_hash &&
        keys.case_hash === reply.case_hash &&
        sha(encoded(keys.item)) === registered.key_hash,
      'changed scoring key',
    );
    const cell = cells.find((entry) => entry.reply_id === reply.id);
    if (registration.mode !== 'demo') {
      const replyFile = path.join(run, 'attempts', cell.id, 'result', 'reply.txt');
      assert(fs.existsSync(replyFile) && sha(fs.readFileSync(replyFile)) === reply.reply_sha256, 'changed raw reply');
    }
    if (!allowInvalidAnswers) checkAnswer(reply, keys.item, cell.kind);
  }
  return candidate;
}

function checkAnswer(reply, item, kind) {
  assert(
    Array.isArray(reply.matched_key_ids) && new Set(reply.matched_key_ids).size === reply.matched_key_ids.length,
    'matched keys',
  );
  assert(
    reply.matched_key_ids.every((id) => item.keys.some((key) => key.id === id)),
    'unknown key',
  );
  assert(
    Array.isArray(reply.novel_valid_findings) &&
      reply.novel_valid_findings.every((v) => typeof v === 'string' && v.trim()),
    'novel findings',
  );
  assert(
    Array.isArray(reply.false_claims) && reply.false_claims.every((v) => typeof v === 'string' && v.trim()),
    'false claims',
  );
  assert(['approve', 'reject'].includes(reply.verdict), 'verdict');
  assert(kind === 'clean' ? typeof reply.false_blocker === 'boolean' : reply.false_blocker === null, 'false blocker');
  assert(!(kind === 'clean' && reply.false_blocker && reply.verdict !== 'reject'), 'false blocker verdict');
}

export async function adjudicate(run, importFile) {
  const file = path.join(run, 'worksheet.json');
  const draft = fs.existsSync(file) ? checkWorksheet(run, readJson(file), true) : worksheet(run);
  if (importFile) {
    const imported = checkWorksheet(run, readJson(importFile));
    persist(path.join(run, 'adjudication.json'), imported);
    return imported;
  }
  const io = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const reply of draft.replies) {
      const keys = readJson(path.join(run, 'keys', `${reply.case_id}.json`));
      const kind = keys.item.kind;
      try {
        checkAnswer(reply, keys.item, kind);
        continue;
      } catch {
        // A saved draft can contain an unfinished or invalid answer.
      }
      process.stdout.write(`\nReply ${reply.id}, case ${reply.case_id}\n${reply.reply}\n`);
      process.stdout.write(
        `Frozen key:\n${keys.item.keys.map((key) => `${key.id}: ${key.summary} (${key.scenario})`).join('\n')}\n`,
      );
      while (true) {
        reply.matched_key_ids = (await io.question('Matched key IDs, comma separated (blank for none): '))
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        reply.novel_valid_findings = (await io.question('Novel valid findings, separated by | (blank for none): '))
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);
        reply.false_claims = (await io.question('False claims, separated by | (blank for none): '))
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);
        reply.verdict = (await io.question('Verdict, approve or reject: ')).trim();
        const blockerAnswer =
          kind === 'clean' ? (await io.question('False blocker on this control, yes or no: ')).trim() : null;
        reply.false_blocker = blockerAnswer === 'yes' ? true : blockerAnswer === 'no' ? false : null;
        try {
          checkAnswer(reply, keys.item, kind);
          persist(file, draft);
          break;
        } catch (error) {
          process.stdout.write(`Invalid answer: ${error.message}. Enter this reply again.\n`);
        }
      }
    }
  } finally {
    io.close();
  }
  const final = checkWorksheet(run, draft);
  persist(path.join(run, 'adjudication.json'), final);
  return final;
}

export function report(run) {
  const { registration, cells } = registeredCells(run);
  const continuationFile = path.join(run, 'continuation-registration.json');
  const continuation = fs.existsSync(continuationFile) ? readJson(continuationFile) : null;
  const scoring = fs.existsSync(path.join(run, 'adjudication.json'))
    ? checkWorksheet(run, readJson(path.join(run, 'adjudication.json')))
    : null;
  const decisions = new Map(scoring?.replies.map((reply) => [reply.id, reply]) || []);
  const disputedControls = new Set(
    cells
      .filter(
        (cell) =>
          cell.kind === 'clean' &&
          cell.execution?.status === 'completed' &&
          decisions.get(cell.reply_id)?.novel_valid_findings.length,
      )
      .map((cell) => cell.case_id),
  );
  const groups = new Map();
  for (const cell of cells) {
    const key = `${cell.source_mode}/${cell.family}/${cell.model}/${cell.effort}`;
    if (!groups.has(key))
      groups.set(key, {
        source_mode: cell.source_mode,
        family: cell.family,
        model: cell.model,
        requested_effort: cell.effort,
        cells: 0,
        completed: 0,
        pending: 0,
        failures: 0,
        void: 0,
        unverified: 0,
        bug_cases: 0,
        clean_controls: 0,
        registered_clean_controls: 0,
        matched_keys: 0,
        key_denominator: 0,
        false_blockers: 0,
        false_claims: 0,
        disputed_controls: 0,
        eligible_clean_controls: 0,
        elapsed_ms: 0,
        known_elapsed_cells: 0,
        unknown_elapsed_cells: 0,
        known_cost_usd: 0,
        known_cost_cells: 0,
        unknown_cost_cells: 0,
        input_tokens: 0,
        output_tokens: 0,
        known_usage_cells: 0,
        unknown_usage_cells: 0,
      });
    const group = groups.get(key);
    group.cells++;
    if (cell.kind === 'clean') group.registered_clean_controls++;
    const execution = cell.execution;
    if (!execution || execution.status === 'reserved') {
      group.pending++;
      if (execution?.status === 'reserved') {
        group.unknown_cost_cells++;
        group.unknown_usage_cells++;
        group.unknown_elapsed_cells++;
      }
      continue;
    }
    if (Number.isFinite(execution.elapsedMs)) {
      group.elapsed_ms += execution.elapsedMs;
      group.known_elapsed_cells++;
    } else group.unknown_elapsed_cells++;
    if (execution.cost_usd === null || execution.cost_usd === undefined) group.unknown_cost_cells++;
    else {
      group.known_cost_usd += execution.cost_usd;
      group.known_cost_cells++;
    }
    if (!execution.usage) group.unknown_usage_cells++;
    else {
      group.known_usage_cells++;
      group.input_tokens += execution.usage.input_tokens || 0;
      group.output_tokens += execution.usage.output_tokens || 0;
    }
    if (execution.status !== 'completed') {
      group.failures++;
      continue;
    }
    group.completed++;
    if (execution.observed.state === 'void') {
      group.void++;
      continue;
    }
    if (
      execution.observed.state !== 'verified' &&
      !(registration.mode === 'demo' && execution.observed.state === 'demo')
    ) {
      group.unverified++;
      continue;
    }
    const decision = decisions.get(cell.reply_id);
    if (!decision) {
      group.pending++;
      continue;
    }
    group.false_claims += decision.false_claims.length;
    const keys = readJson(path.join(run, 'keys', `${cell.case_id}.json`)).item.keys;
    if (cell.kind === 'bug') {
      group.bug_cases++;
      group.matched_keys += decision.matched_key_ids.length;
      group.key_denominator += keys.length;
    } else {
      group.clean_controls++;
      if (disputedControls.has(cell.case_id)) group.disputed_controls++;
      else {
        group.eligible_clean_controls++;
        if (decision.false_blocker) group.false_blockers++;
      }
    }
  }
  const byCase = new Map();
  for (const cell of cells) {
    const key = `${cell.source_mode}/${cell.case_id}/${cell.model}/${cell.effort}`;
    if (!byCase.has(key))
      byCase.set(key, {
        source_mode: cell.source_mode,
        case_id: cell.case_id,
        family: cell.family,
        kind: cell.kind,
        model: cell.model,
        requested_effort: cell.effort,
        registered_repeats: 0,
        scored_repeats: 0,
        matched_keys: 0,
        key_denominator: 0,
        false_blockers: 0,
        false_claims: 0,
        disputed_controls: 0,
        eligible_clean_controls: 0,
        failures: 0,
        void: 0,
        unverified: 0,
        pending: 0,
        elapsed_ms: 0,
        known_elapsed_cells: 0,
        unknown_elapsed_cells: 0,
        known_cost_usd: 0,
        known_cost_cells: 0,
        unknown_cost_cells: 0,
        input_tokens: 0,
        output_tokens: 0,
        known_usage_cells: 0,
        unknown_usage_cells: 0,
        missing_repeats: [],
      });
    const item = byCase.get(key);
    item.registered_repeats++;
    const decision = decisions.get(cell.reply_id);
    const observed = cell.execution?.observed?.state;
    if (!cell.execution || cell.execution.status === 'reserved') {
      item.pending++;
      if (cell.execution?.status === 'reserved') {
        item.unknown_cost_cells++;
        item.unknown_usage_cells++;
        item.unknown_elapsed_cells++;
      }
    } else {
      if (Number.isFinite(cell.execution.elapsedMs)) {
        item.elapsed_ms += cell.execution.elapsedMs;
        item.known_elapsed_cells++;
      } else item.unknown_elapsed_cells++;
      if (cell.execution.cost_usd === null || cell.execution.cost_usd === undefined) item.unknown_cost_cells++;
      else {
        item.known_cost_usd += cell.execution.cost_usd;
        item.known_cost_cells++;
      }
      if (!cell.execution.usage) item.unknown_usage_cells++;
      else {
        item.known_usage_cells++;
        item.input_tokens += cell.execution.usage.input_tokens || 0;
        item.output_tokens += cell.execution.usage.output_tokens || 0;
      }
      if (cell.execution.status !== 'completed') item.failures++;
      else if (observed === 'void') item.void++;
      else if (observed !== 'verified' && !(registration.mode === 'demo' && observed === 'demo')) item.unverified++;
      else if (!decision) item.pending++;
    }
    if (!decision || (observed !== 'verified' && !(registration.mode === 'demo' && observed === 'demo'))) {
      item.missing_repeats.push(cell.repeat);
      continue;
    }
    item.scored_repeats++;
    item.false_claims += decision.false_claims.length;
    if (cell.kind === 'bug') {
      item.matched_keys += decision.matched_key_ids.length;
      item.key_denominator += readJson(path.join(run, 'keys', `${cell.case_id}.json`)).item.keys.length;
    } else if (disputedControls.has(cell.case_id)) item.disputed_controls++;
    else {
      item.eligible_clean_controls++;
      if (decision.false_blocker) item.false_blockers++;
    }
  }
  const summary = {
    schema: 'arc-review-report-v1',
    run_id: registration.run_id,
    mode: registration.mode,
    limitation,
    note: 'Descriptive results only. Missing cells remain missing. Clean controls have no recall denominator. No automatic winner.',
    cases: [...byCase.values()],
    families: [...groups.values()],
    cells: cells.map((cell) => ({
      ...(continuation
        ? {
            execution_block: continuation.selected.includes(cell.id) ? continuation.kind : 'original',
            execution_block_id: continuation.selected.includes(cell.id) ? continuation.block_id : registration.run_id,
          }
        : {}),
      reply_id: cell.reply_id,
      case_id: cell.case_id,
      source_mode: cell.source_mode,
      model: cell.model,
      requested_effort: cell.effort,
      repeat: cell.repeat,
      status: cell.execution?.status || 'missing',
      observed: cell.execution?.observed || null,
      cost_usd: cell.execution?.cost_usd ?? null,
      scoring: decisions.get(cell.reply_id) || null,
    })),
  };
  persist(path.join(run, 'report.json'), summary);
  const textFile = path.join(run, 'report.md');
  const tempFile = `${textFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, renderReport(summary), { flag: 'wx' });
  fs.renameSync(tempFile, textFile);
  return summary;
}

function display(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}
function money(row) {
  if (!row.known_cost_cells && row.unknown_cost_cells) return `${row.unknown_cost_cells} unknown`;
  return row.unknown_cost_cells
    ? `$${row.known_cost_usd.toFixed(4)} known, ${row.unknown_cost_cells} unknown`
    : `$${row.known_cost_usd.toFixed(4)}`;
}
function tokens(row) {
  if (!row.known_usage_cells && row.unknown_usage_cells) return `${row.unknown_usage_cells} unknown`;
  return `${row.input_tokens}/${row.output_tokens}${row.unknown_usage_cells ? `, ${row.unknown_usage_cells} unknown` : ''}`;
}
function coverage(row) {
  if (row.scored_repeats === 0) return 'pending';
  return row.kind === 'bug' ? `${row.matched_keys}/${row.key_denominator}` : 'control';
}
function blockers(row) {
  if (row.kind === 'bug' || row.registered_clean_controls === 0) return 'n/a';
  return row.eligible_clean_controls
    ? `${row.false_blockers}/${row.eligible_clean_controls}`
    : row.disputed_controls
      ? 'disputed'
      : 'pending';
}
function duration(row) {
  if (!row.known_elapsed_cells && row.unknown_elapsed_cells) return `${row.unknown_elapsed_cells} unknown`;
  return `${(row.elapsed_ms / 1000).toFixed(1)}s${row.unknown_elapsed_cells ? ` known, ${row.unknown_elapsed_cells} unknown` : ''}`;
}
function table(headers, rows) {
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((row) => `| ${row.map(display).join(' | ')} |`).join('\n')}\n`;
}
export function renderReport(summary) {
  const lines = [
    '# Arc review evaluation',
    '',
    `Run: ${summary.run_id}`,
    `Mode: ${summary.mode}`,
    '',
    summary.limitation,
    '',
    summary.note,
    '',
    '## Cases',
    '',
  ];
  lines.push(
    table(
      [
        'Case',
        'Source',
        'Model',
        'Effort',
        'Scored / expected',
        'Known keys',
        'False blockers',
        'False claims',
        'Disputed controls',
        'Failures',
        'Void',
        'Unverified',
        'Pending',
        'Tokens in/out',
        'Cost estimate',
        'Time',
      ],
      summary.cases.map((row) => [
        row.case_id,
        row.source_mode,
        row.model,
        row.requested_effort,
        `${row.scored_repeats}/${row.registered_repeats}`,
        coverage(row),
        blockers(row),
        row.false_claims,
        row.disputed_controls,
        row.failures,
        row.void,
        row.unverified,
        row.pending,
        tokens(row),
        money(row),
        duration(row),
      ]),
    ),
  );
  lines.push('', '## Families', '');
  lines.push(
    table(
      [
        'Source',
        'Family',
        'Model',
        'Effort',
        'Scored / expected',
        'Known keys',
        'False blockers',
        'False claims',
        'Disputed controls',
        'Failures',
        'Void',
        'Unverified',
        'Pending',
        'Tokens in/out',
        'Cost estimate',
        'Time',
      ],
      summary.families.map((row) => [
        row.source_mode,
        row.family,
        row.model,
        row.requested_effort,
        `${row.bug_cases + row.clean_controls}/${row.cells}`,
        row.key_denominator
          ? `${row.matched_keys}/${row.key_denominator}`
          : row.registered_clean_controls === row.cells
            ? 'control'
            : 'pending',
        blockers(row),
        row.false_claims,
        row.disputed_controls,
        row.failures,
        row.void,
        row.unverified,
        row.pending,
        tokens(row),
        money(row),
        duration(row),
      ]),
    ),
  );
  return lines.join('\n') + '\n';
}
