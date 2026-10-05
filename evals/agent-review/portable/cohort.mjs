import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assert, captureInstructions, copyInputs, encoded, loadCase, qualify, readJson, root, sha } from './core.mjs';

const hash = /^[a-f0-9]{64}$/;
const categories = ['diff-local', 'cross-file', 'runtime-interaction'];
const mechanismIdentifier = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const targets = {
  bugs: 24,
  controls: 8,
  clusters: 16,
  production_exports: 12,
  subsystems: 8,
  runtime_mechanisms: 3,
  independent_controls: 4,
  'diff-local': 6,
  'cross-file': 10,
  'runtime-interaction': 6,
};

function checkedFile(folder, name, expected) {
  const file = path.join(folder, name);
  const info = fs.lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink(), `linked cohort file: ${name}`);
  const bytes = fs.readFileSync(file);
  assert(hash.test(expected) && sha(bytes) === expected, `cohort hash changed: ${name}`);
  return bytes;
}

export function readCohort(file) {
  const cohort = readJson(file);
  assert(cohort.schema === 'arc-review-cohort-v1' && cohort.revision === 1, 'cohort schema');
  assert(encoded(cohort.targets) === encoded(targets), 'cohort coverage targets changed');
  assert(Array.isArray(cohort.entries) && cohort.entries.length > 0, 'cohort entries');
  assert(new Set(cohort.entries.map((entry) => entry.case_id)).size === cohort.entries.length, 'duplicate cohort case');
  for (const entry of cohort.entries) {
    assert(entry.readiness === 'qualified' && entry.revision === 1, `case readiness: ${entry.case_id}`);
    assert(
      categories.includes(entry.category) && entry.cluster && entry.subsystem,
      `case classification: ${entry.case_id}`,
    );
    if (entry.category === 'runtime-interaction' && entry.kind === 'bug')
      assert(
        typeof entry.runtime_mechanism === 'string' && mechanismIdentifier.test(entry.runtime_mechanism),
        `runtime mechanism: ${entry.case_id}`,
      );
    assert(
      entry.selection_reason && entry.independence_reason && entry.evidence_group === 'ordinary',
      'case selection',
    );
    assert(
      entry.kind === 'bug' || (entry.kind === 'clean' && entry.control_origin === 'independent-legitimate-change'),
      'control admission',
    );
    assert(
      entry.qualification &&
        entry.qualification.reinjection === (entry.kind === 'bug' ? 'symptom-fails' : 'not-applicable'),
      'qualification receipt',
    );
    assert(
      Array.isArray(entry.leakage_markers) &&
        entry.leakage_markers.every((marker) => typeof marker === 'string' && marker.length > 10),
      'leakage markers',
    );
    assert(
      ['base', 'candidate', 'correction'].every((name) => /^[a-f0-9]{40}$/.test(entry.provenance?.[name])),
      'historical source identities',
    );
  }
  return cohort;
}

function auditAssigned(loaded, entry, instructions) {
  const prompt = fs.readFileSync(path.join(loaded.fixture, 'prompt.txt'), 'utf8');
  const diff = fs.readFileSync(path.join(loaded.fixture, 'candidate.diff'), 'utf8');
  const assigned = [
    ...loaded.item.inputs.map((input) => ({
      name: input.path,
      text: fs.readFileSync(path.join(loaded.fixture, 'input', input.path), 'utf8'),
    })),
    { name: 'prompt', text: prompt },
    { name: 'diff', text: diff },
    ...instructions.map((doc) => ({ name: doc.path, text: doc.bytes.toString('utf8') })),
  ];
  for (const { name, text } of assigned) {
    assert(
      !/\.test\.[cm]?[jt]s$|(?:^|\/)(?:qualify|provenance|keys|reference)(?:[./]|$)/i.test(name),
      `answer file assigned: ${name}`,
    );
    for (const forbidden of entry.leakage_markers) assert(!text.includes(forbidden), `answer leakage: ${name}`);
    assert(!text.includes(entry.provenance.correction), `correction identity assigned: ${name}`);
  }
  return {
    assigned_files: assigned.length,
    answer_markers: entry.leakage_markers.length,
    condition: 'audited-assigned-inputs',
    limitation: 'This check audits assigned bytes. It does not enforce host-read or network denial.',
  };
}

export function qualifyCohort(file) {
  const cohort = readCohort(file);
  const instructions = captureInstructions(root, [], cohort.audited_instructions);
  const results = [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-review-cohort-'));
  try {
    for (const entry of cohort.entries) {
      const loaded = loadCase(entry.case_id);
      assert(
        loaded.item.kind === entry.kind &&
          loaded.item.family === entry.cluster &&
          loaded.caseHash === entry.case_sha256,
        `case identity changed: ${entry.case_id}`,
      );
      const provenance = JSON.parse(checkedFile(loaded.fixture, 'provenance.json', entry.provenance_sha256));
      assert(encoded(provenance.source) === encoded(entry.provenance), `source identity changed: ${entry.case_id}`);
      checkedFile(loaded.fixture, 'qualify.mjs', entry.qualifier_sha256);
      assert(
        provenance.source_files.length + provenance.generated_files.length === loaded.item.inputs.length,
        `source closure: ${entry.case_id}`,
      );
      for (const source of provenance.source_files) {
        const candidateBytes = checkedFile(path.join(loaded.fixture, 'input'), source.path, source.candidate_sha256);
        const referenceBytes = checkedFile(
          path.join(loaded.fixture, 'reference'),
          source.path,
          source.reference_sha256,
        );
        for (const [bytes, object] of [
          [candidateBytes, source.candidate_blob],
          [referenceBytes, source.reference_blob],
        ]) {
          assert(
            createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === object,
            `source object mismatch: ${source.path}`,
          );
          for (const match of bytes
            .toString('utf8')
            .matchAll(/^\s*(?:import|export)\s+(?:type\s+)?[^;]*?\bfrom\s*['"](\.[^'"]+)['"]/gm)) {
            const imported = path.posix.normalize(path.posix.join(path.posix.dirname(source.path), match[1]));
            assert(
              [imported, imported + '.ts', imported + '.js', imported + '/index.ts'].some((name) =>
                loaded.item.inputs.some((input) => input.path === name),
              ),
              `missing source import: ${source.path}`,
            );
          }
        }
      }
      for (const generated of provenance.generated_files) {
        checkedFile(path.join(loaded.fixture, 'input'), generated.path, generated.candidate_sha256);
        checkedFile(path.join(loaded.fixture, 'reference'), generated.path, generated.reference_sha256);
      }
      const audit = auditAssigned(loaded, entry, instructions);
      const candidate = path.join(scratch, entry.case_id, 'candidate');
      copyInputs(path.join(loaded.fixture, 'input'), candidate, loaded.item.inputs);
      const script = path.join(loaded.fixture, 'qualify.mjs');
      const result = qualify(script, candidate, path.join(loaded.fixture, 'reference'), entry.kind);
      if (provenance.source.change_origin === 'reconstructed-causal-introduction') {
        const base = provenance.reconstructed_base;
        assert(base && base.source_anchor === provenance.source.candidate, 'reconstructed base identity');
        checkedFile(path.join(loaded.fixture, 'base'), base.path, base.source_sha256);
        checkedFile(path.join(loaded.fixture, 'base'), 'runtime.cjs', base.runtime_sha256);
        const boundary = qualify(
          script,
          path.join(loaded.fixture, 'base'),
          path.join(loaded.fixture, 'reference'),
          'clean',
        );
        assert(encoded(boundary.candidate) === encoded(base.result), 'reconstructed base qualification');
      }
      let reinjection = null;
      if (entry.kind === 'bug') {
        const mutated = path.join(scratch, entry.case_id, 'reinjected');
        const referenceInputs = loaded.item.inputs.map((input) => ({
          path: input.path,
          sha256: sha(fs.readFileSync(path.join(loaded.fixture, 'reference', input.path))),
        }));
        copyInputs(path.join(loaded.fixture, 'reference'), mutated, referenceInputs);
        const changed = loaded.item.inputs.filter(
          (input) => input.sha256 !== referenceInputs.find((other) => other.path === input.path).sha256,
        );
        assert(changed.length > 0, `missing reinjection: ${entry.case_id}`);
        for (const input of changed)
          fs.writeFileSync(path.join(mutated, input.path), fs.readFileSync(path.join(candidate, input.path)));
        reinjection = qualify(script, mutated, path.join(loaded.fixture, 'reference'), 'bug').candidate;
      }
      assert(
        encoded(result) === encoded(entry.qualification.result),
        `qualification receipt changed: ${entry.case_id}`,
      );
      results.push({
        case_id: entry.case_id,
        result,
        reinjection,
        audit,
        source_files: provenance.source_files.length,
      });
    }
    return {
      schema: 'arc-review-cohort-qualification-v1',
      cohort_id: cohort.id,
      complete: true,
      final_coverage_complete: false,
      results,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function cohortCoverage(file) {
  const cohort = readCohort(file);
  const bugs = cohort.entries.filter((entry) => entry.kind === 'bug');
  const controls = cohort.entries.filter((entry) => entry.kind === 'clean');
  const clusters = new Set(bugs.map((entry) => entry.cluster));
  const subsystems = new Set(bugs.map((entry) => entry.subsystem));
  const mechanisms = new Set(
    bugs
      .filter(
        (entry) =>
          entry.category === 'runtime-interaction' &&
          typeof entry.runtime_mechanism === 'string' &&
          mechanismIdentifier.test(entry.runtime_mechanism),
      )
      .map((entry) => entry.runtime_mechanism),
  );
  const actual = {
    bugs: bugs.length,
    controls: controls.length,
    clusters: clusters.size,
    production_exports: bugs.length,
    subsystems: subsystems.size,
    runtime_mechanisms: mechanisms.size,
    independent_controls: controls.length,
  };
  for (const category of categories) actual[category] = bugs.filter((entry) => entry.category === category).length;
  const gaps = Object.entries(cohort.targets)
    .filter(([name, minimum]) => actual[name] < minimum)
    .map(([name, minimum]) => ({ name, present: actual[name], required: minimum, missing: minimum - actual[name] }));
  for (const entry of bugs) {
    if (bugs.filter((other) => other.cluster === entry.cluster).length > 2)
      gaps.push({ name: 'cluster-limit', cluster: entry.cluster });
    if (bugs.filter((other) => other.subsystem === entry.subsystem).length > 4)
      gaps.push({ name: 'subsystem-limit', subsystem: entry.subsystem });
  }
  return { schema: 'arc-review-cohort-coverage-v1', cohort_id: cohort.id, complete: gaps.length === 0, actual, gaps };
}
