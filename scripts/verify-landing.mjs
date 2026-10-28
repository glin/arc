import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_TIMEOUT_EXIT } from '../extension/test/machineload.mjs';
import {
  collectSuite,
  completeTestDiagnostics,
  categoryFailure,
  environmentIdentity,
  failedTests,
  git,
  hash,
  laneCommand,
  root,
  suiteLanes,
  trackedIdentity,
} from './test-suite.mjs';

function requireCondition(condition, message) {
  if (!condition) throw Error(message);
}
function evidenceFile(reference, parse = true) {
  requireCondition(
    reference && isAbsolute(reference.path) && /^[a-f0-9]{64}$/.test(reference.sha256),
    'Evidence requires an absolute path and SHA-256.',
  );
  const content = readFileSync(reference.path);
  requireCondition(hash(content) === reference.sha256, `Evidence changed: ${reference.path}`);
  return parse ? JSON.parse(content) : content;
}
function checkArtifacts(report) {
  for (const category of report.categories) {
    requireCondition(hash(readFileSync(category.log)) === category.logHash, `Category log changed: ${category.id}`);
    if (category.testsHash) {
      requireCondition(
        hash(readFileSync(category.tests)) === category.testsHash,
        `Test results changed: ${category.id}`,
      );
      const failures = failedTests(category.tests, category.id, report.checkout);
      if (failures.length)
        requireCondition(
          JSON.stringify(failures) === JSON.stringify(category.failures),
          `Reported failures differ from test results: ${category.id}`,
        );
    }
    for (const failure of category.failures.filter((row) => row.name == null))
      requireCondition(
        JSON.stringify(failure) === JSON.stringify(categoryFailure(category, report.checkout)),
        `Category diagnostics changed: ${category.id}`,
      );
  }
}

function affectedCheckPassed(report, check) {
  const category = report.categories.find((row) => row.id === (typeof check === 'string' ? check : check?.category));
  if (typeof check === 'string') return category?.status === 'passed';
  if (!category?.testsHash || category.status === 'blocked' || category.status === 'cancelled') return false;
  const tests = JSON.parse(readFileSync(category.tests));
  const matches = (tests.testResults ?? []).flatMap((suite) =>
    suite.name.replaceAll('\\', '/').replace(report.checkout.replaceAll('\\', '/') + '/', '') === check.file
      ? (suite.assertionResults ?? []).filter((test) => test.fullName === check.name)
      : [],
  );
  return matches.length > 0 && matches.every((test) => test.status === 'passed');
}

export function validateAcceptance({
  report,
  reportHash,
  policy,
  current,
  base,
  expectedCategories,
  expectedLanes,
  environment,
}) {
  requireCondition(report.schema === 1 && report.mode === 'all', 'Landing requires a complete suite report.');
  requireCondition(/^[a-f0-9]{40}$/.test(base) && report.base === base, 'Integration base changed.');
  requireCondition(
    current.clean && report.start.clean && report.end.clean,
    'Landing requires clean tracked candidate files.',
  );
  for (const identity of [
    report.start,
    report.end,
    ...report.categories.flatMap((row) => [row.sourceStart, row.sourceEnd]),
  ]) {
    requireCondition(
      identity?.clean && identity.candidate === current.candidate && identity.treeHash === current.treeHash,
      'Candidate or tracked content changed.',
    );
  }
  requireCondition(
    report.environment.hash === report.environmentEnd.hash && report.environment.hash === environment.hash,
    'Test environment changed.',
  );
  requireCondition(
    JSON.stringify(report.selected) === JSON.stringify(expectedCategories),
    'Selected categories do not match the complete suite.',
  );
  requireCondition(
    JSON.stringify(report.categories.map((row) => row.id)) === JSON.stringify(expectedCategories),
    'Missing or duplicate category results.',
  );
  requireCondition(
    report.categories.every((row) => ['passed', 'failed', 'blocked', 'cancelled'].includes(row.status)),
    'Every category requires a terminal result.',
  );
  requireCondition(
    expectedLanes?.length === report.categories.length &&
      expectedLanes.every((lane, index) => {
        const category = report.categories[index];
        return (
          category.cwd === lane.cwd &&
          JSON.stringify(category.command) === JSON.stringify(laneCommand(lane, category.tests))
        );
      }),
    'Category command identity changed.',
  );
  requireCondition(
    !report.categories.some((row) => row.status === 'cancelled'),
    'Cancelled coverage cannot authorize landing.',
  );
  checkArtifacts(report);
  requireCondition(
    report.categories.every(
      (category) => !category.testsHash || completeTestDiagnostics(JSON.parse(readFileSync(category.tests))),
    ),
    'Landing requires complete test diagnostics through process closure.',
  );
  const failures = report.categories.flatMap((row) => row.failures.map((failure) => ({ ...failure, category: row })));
  requireCondition(
    report.categories.every((row) =>
      row.status === 'passed' ? row.exitCode === 0 && row.failures.length === 0 : row.failures.length > 0,
    ),
    'Category status conflicts with its results.',
  );
  if (failures.length === 0) {
    requireCondition(report.exitCode === 0, 'Suite result is incomplete.');
    return { accepted: true, suiteExitCode: report.exitCode, exceptions: [] };
  }
  requireCondition(report.exitCode !== 0, 'Failed coverage requires a failed suite result.');
  requireCondition(
    policy?.authority === 'owner-authorized-unrelated-failures',
    'Remaining failures require explicit owner-authorized dispositions.',
  );
  requireCondition(
    policy.candidate === current.candidate && policy.base === base && policy.reportHash === reportHash,
    'Policy does not match the candidate, base, and report.',
  );
  requireCondition(
    Array.isArray(policy.affectedChecks) &&
      policy.affectedChecks.length > 0 &&
      new Set(policy.affectedChecks.map((check) => JSON.stringify(check))).size === policy.affectedChecks.length,
    'Policy requires affected checks.',
  );
  for (const check of policy.affectedChecks)
    requireCondition(affectedCheckPassed(report, check), `Affected check did not pass: ${JSON.stringify(check)}`);
  requireCondition(
    Array.isArray(policy.dispositions) &&
      policy.dispositions.length === failures.length &&
      new Set(policy.dispositions.map((row) => row.failure)).size === failures.length,
    'Every failure requires exactly one disposition.',
  );
  for (const failure of failures) {
    const disposition = policy.dispositions.find((row) => row.failure === failure.id);
    requireCondition(
      disposition && ['base-existing', 'unrelated-infrastructure'].includes(disposition.classification),
      `Failure lacks an unrelated disposition: ${failure.id}`,
    );
    requireCondition(
      typeof disposition.explanation === 'string' &&
        disposition.explanation.trim().length > 0 &&
        typeof disposition.reviewedBy === 'string' &&
        disposition.reviewedBy.trim().length > 0,
      `Disposition requires explanation and review: ${failure.id}`,
    );
    const evidence = evidenceFile(disposition.evidence);
    if (disposition.classification === 'base-existing') {
      requireCondition(
        failure.category.status === 'failed' &&
          (failure.name != null ||
            (!failure.category.tests &&
              !failure.category.reason &&
              readFileSync(failure.category.log, 'utf8').trim().length > 0)),
        'Base comparison requires concrete test or static diagnostics.',
      );
      requireCondition(
        evidence.start?.candidate === base &&
          evidence.end?.candidate === base &&
          evidence.start.clean &&
          evidence.end.clean &&
          evidence.start.treeHash === evidence.end.treeHash &&
          evidence.categories.every((row) =>
            [row.sourceStart, row.sourceEnd].every(
              (identity) =>
                identity?.clean && identity.candidate === base && identity.treeHash === evidence.start.treeHash,
            ),
          ),
        'Comparison must test the clean actual base.',
      );
      requireCondition(
        evidence.environment?.hash === report.environment.hash &&
          evidence.environmentEnd?.hash === evidence.environment.hash,
        'Comparison setup differs from the candidate.',
      );
      checkArtifacts(evidence);
      const comparison = evidence.categories.find((row) => row.id === failure.category.id);
      requireCondition(
        comparison?.status === failure.category.status &&
          comparison.failures.some((row) => row.id === failure.id && row.detail === failure.detail),
        `Base comparison does not reproduce: ${failure.id}`,
      );
    } else {
      requireCondition(
        evidence.candidate === current.candidate &&
          evidence.base === base &&
          evidence.reportHash === reportHash &&
          evidence.failure === failure.id,
        'Infrastructure evidence does not match this failure.',
      );
      requireCondition(
        typeof evidence.cause === 'string' &&
          evidence.cause.trim().length > 0 &&
          typeof evidence.independence === 'string' &&
          evidence.independence.trim().length > 0,
        'Infrastructure evidence requires cause and affected-check independence.',
      );
      requireCondition(
        Array.isArray(evidence.artifacts) && evidence.artifacts.length > 0,
        'Infrastructure evidence requires concrete artifacts.',
      );
      for (const artifact of evidence.artifacts) evidenceFile(artifact, false);
    }
    requireCondition(
      !policy.affectedChecks.some((check) =>
        typeof check === 'string'
          ? check === failure.category.id
          : check.category === failure.category.id && check.file === failure.file && check.name === failure.name,
      ),
      `Affected category cannot be excepted: ${failure.category.id}`,
    );
  }
  return { accepted: true, suiteExitCode: report.exitCode, exceptions: failures.map((failure) => failure.id) };
}

export async function verifyLanding({ cwd = root, base, reportDir, policyPath, collect = collectSuite } = {}) {
  requireCondition(/^[a-f0-9]{40}$/.test(base ?? ''), '--base requires a full commit SHA.');
  requireCondition(git(cwd, 'rev-parse', `${base}^{commit}`) === base, 'Integration base is unavailable.');
  requireCondition(
    git(cwd, 'merge-base', 'HEAD', base) === base,
    'Candidate does not descend from the integration base.',
  );
  requireCondition(reportDir && isAbsolute(reportDir), '--report-dir requires an external absolute directory.');
  const distance = relative(realpathSync(cwd), resolve(reportDir));
  requireCondition(
    distance.startsWith('..') || isAbsolute(distance),
    'Landing reports must live outside the candidate checkout.',
  );
  const file = join(reportDir, 'suite.json');
  if (!existsSync(file)) await collect({ cwd, mode: 'all', base, reportDir });
  const content = readFileSync(file);
  const report = JSON.parse(content);
  let decision;
  try {
    const receipt = JSON.parse(readFileSync(join(reportDir, 'collection-receipt.json')));
    requireCondition(
      receipt.schema === 1 && receipt.reportHash === hash(content),
      'Collection receipt does not match the retained report.',
    );
    decision = validateAcceptance({
      report,
      reportHash: hash(content),
      policy: policyPath && existsSync(policyPath) ? JSON.parse(readFileSync(policyPath)) : null,
      current: trackedIdentity(cwd),
      base,
      expectedCategories: suiteLanes(cwd, 'all').map((row) => row.id),
      expectedLanes: suiteLanes(cwd, 'all'),
      environment: environmentIdentity(cwd),
    });
  } catch (error) {
    decision = { accepted: false, suiteExitCode: report.exitCode, reason: error.message };
  }
  writeFileSync(
    join(reportDir, 'acceptance.json'),
    JSON.stringify({ ...decision, candidate: report.start.candidate, base, reportHash: hash(content) }, null, 2) + '\n',
  );
  return decision;
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const args = process.argv.slice(2);
    requireCondition(
      args.length % 2 === 0 &&
        args.every((arg, index) => index % 2 || ['--base', '--report-dir', '--policy'].includes(arg)),
      'Use --base <SHA> --report-dir <external directory> --policy <external JSON file>.',
    );
    const options = Object.fromEntries(
      Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2], args[index * 2 + 1]]),
    );
    const decision = await verifyLanding({
      base: options['--base'],
      reportDir: options['--report-dir'],
      policyPath: options['--policy'],
    });
    console.log(
      decision.accepted
        ? `Landing accepted. Suite exit status: ${decision.suiteExitCode}.`
        : `Landing refused: ${decision.reason}`,
    );
    // A collection that stopped on the memory floor keeps its own status, so a caller can tell it from a refusal.
    process.exitCode = decision.accepted ? 0 : decision.suiteExitCode === MEMORY_TIMEOUT_EXIT ? MEMORY_TIMEOUT_EXIT : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
