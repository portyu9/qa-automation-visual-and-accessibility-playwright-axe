import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyLeafJobFailure,
  classifyRunFailure,
  matchingTransientSignatures,
  recoveryScopeAssessment,
  validateRecoveryConfig,
} from './dependency-recovery.mjs';

const governanceConfig = JSON.parse(readFileSync('.github/dependency-governance.json', 'utf8'));
const recoveryConfig = JSON.parse(readFileSync('.github/dependency-recovery.json', 'utf8'));

function job({
  id = 1,
  name = 'quality',
  step = 'Install dependencies',
  conclusion = 'failure',
} = {}) {
  return {
    id,
    name,
    conclusion,
    steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: step, conclusion },
    ],
  };
}

test('recovery config is valid, bounded, and excludes functional and security findings', () => {
  assert.deepEqual(validateRecoveryConfig(recoveryConfig), []);
  assert.equal(recoveryConfig.maxRunAttempts, 2);
  for (const forbidden of [
    'Static quality gate',
    'Run framework contract gate',
    'Run accessibility gate',
    'Run smoke suite',
    'Compare against canonical baseline',
    'Audit dependency graph',
    'Audit npm dependency graph at HIGH/CRITICAL severity',
    'Scan dependencies, configuration, and repository secrets',
    'Review dependency changes',
    'Analyze',
    'Evaluate required jobs',
    'Evaluate security jobs',
  ]) {
    assert.equal(recoveryConfig.transientSteps.includes(forbidden), false, forbidden);
  }
  assert.ok(
    validateRecoveryConfig({ ...recoveryConfig, maxRunAttempts: 4 }).length > 0,
    'attempt cap must not expand silently',
  );
  assert.ok(
    validateRecoveryConfig({
      ...recoveryConfig,
      transientSteps: [...recoveryConfig.transientSteps, 'Run smoke suite'],
    }).length > 0,
    'functional test steps must never become transient-retry candidates',
  );
});

test('transient signature matcher requires precise infrastructure evidence', () => {
  assert.deepEqual(matchingTransientSignatures('npm error code EAI_AGAIN'), ['dns-eai-again']);
  assert.deepEqual(matchingTransientSignatures('request failed with status code 503'), [
    'http-5xx',
  ]);
  assert.deepEqual(matchingTransientSignatures('503 Service Unavailable'), [
    'gateway-service-outage',
  ]);
  assert.deepEqual(matchingTransientSignatures('Service Unavailable'), []);
  assert.deepEqual(matchingTransientSignatures('502 vulnerabilities found'), []);
  assert.deepEqual(matchingTransientSignatures('Test failed: expected 2 to equal 3'), []);
});

test('allowlisted infrastructure step plus proven network signature is retryable', () => {
  const result = classifyLeafJobFailure(
    job({ step: 'Install dependencies' }),
    'npm error code EAI_AGAIN\nnpm error request to registry failed',
    recoveryConfig,
  );
  assert.equal(result.transient, true, result.reason);
  assert.deepEqual(result.signatures, ['dns-eai-again']);
});

test('functional failures are never reclassified as transient even when logs contain network words', () => {
  for (const step of [
    'Static quality gate',
    'Run framework contract gate',
    'Run accessibility gate',
    'Run smoke suite',
    'Compare against canonical baseline',
  ]) {
    const result = classifyLeafJobFailure(
      job({ step }),
      'ETIMEDOUT EAI_AGAIN 503 Service Unavailable',
      recoveryConfig,
    );
    assert.equal(result.transient, false, step);
  }
});

test('security findings are never reclassified as transient even when logs contain network words', () => {
  for (const step of [
    'Audit dependency graph',
    'Audit npm dependency graph at HIGH/CRITICAL severity',
    'Scan dependencies, configuration, and repository secrets',
    'Review dependency changes',
    'Analyze',
  ]) {
    const result = classifyLeafJobFailure(
      job({ name: 'security', step }),
      'ETIMEDOUT EAI_AGAIN 503 Service Unavailable',
      recoveryConfig,
    );
    assert.equal(result.transient, false, step);
  }
});

test('allowlisted infrastructure step without exact transient signature remains blocked', () => {
  const result = classifyLeafJobFailure(
    job({ step: 'Install dependencies' }),
    'npm error ERESOLVE unable to resolve dependency tree',
    recoveryConfig,
  );
  assert.equal(result.transient, false);
  assert.match(result.reason, /no proven transient/);
});

test('multiple failed steps remain ambiguous even if one is transient infrastructure', () => {
  const candidate = job({ step: 'Install dependencies' });
  candidate.steps.push({ name: 'Run smoke suite', conclusion: 'failure' });
  const result = classifyLeafJobFailure(candidate, 'npm error code EAI_AGAIN', recoveryConfig);
  assert.equal(result.transient, false);
  assert.match(result.reason, /exactly one failed step/);
});

test('workflow rerun requires every failed leaf job to be proven transient', () => {
  const run = { status: 'completed', conclusion: 'failure', run_attempt: 1 };
  const transient = job({ id: 10, name: 'quality', step: 'Install dependencies' });
  const gate = job({ id: 11, name: 'quality-gate', step: 'Evaluate required jobs' });
  const positive = classifyRunFailure({
    run,
    jobs: [transient, gate],
    logsByJobId: { 10: 'npm error code ECONNRESET' },
    gateName: 'quality-gate',
    recoveryConfig,
  });
  assert.equal(positive.rerunnable, true, positive.reason);

  const deterministic = job({
    id: 12,
    name: 'smoke / chromium',
    step: 'Run smoke suite',
  });
  const mixed = classifyRunFailure({
    run,
    jobs: [transient, deterministic, gate],
    logsByJobId: {
      10: 'npm error code ECONNRESET',
      12: 'Test timeout ETIMEDOUT while waiting for application response',
    },
    gateName: 'quality-gate',
    recoveryConfig,
  });
  assert.equal(mixed.rerunnable, false);
  assert.match(mixed.reason, /deterministic or ambiguous/);
});

test('aggregate-gate-only failure cannot authorize a rerun', () => {
  const gate = job({ id: 11, name: 'quality-gate', step: 'Evaluate required jobs' });
  const result = classifyRunFailure({
    run: { status: 'completed', conclusion: 'failure', run_attempt: 1 },
    jobs: [gate],
    logsByJobId: { 11: 'npm error code EAI_AGAIN' },
    gateName: 'quality-gate',
    recoveryConfig,
  });
  assert.equal(result.rerunnable, false);
  assert.match(result.reason, /no failed leaf job/);
});

test('workflow recovery is capped after one automatic rerun', () => {
  const result = classifyRunFailure({
    run: { status: 'completed', conclusion: 'failure', run_attempt: 2 },
    jobs: [job({ id: 10, step: 'Install dependencies' })],
    logsByJobId: { 10: 'npm error code EAI_AGAIN' },
    gateName: 'quality-gate',
    recoveryConfig,
  });
  assert.equal(result.rerunnable, false);
  assert.match(result.reason, /reached recovery cap/);
});

test('cancelled, timed-out, and ambiguous workflow states never trigger automatic reruns', () => {
  for (const conclusion of ['cancelled', 'timed_out', 'action_required', 'stale']) {
    const result = classifyRunFailure({
      run: { status: 'completed', conclusion, run_attempt: 1 },
      jobs: [job({ id: 10, step: 'Install dependencies' })],
      logsByJobId: { 10: 'npm error code EAI_AGAIN' },
      gateName: 'quality-gate',
      recoveryConfig,
    });
    assert.equal(result.rerunnable, false, conclusion);
  }
});

test('recovery scope requires canonical provenance, signed metadata, allowlisted ecosystem, and no control-plane paths', () => {
  const base = {
    pull: { changed_files: 2 },
    files: [{ filename: 'package.json' }, { filename: 'package-lock.json' }],
    provenance: { eligible: true, reasons: [] },
    metadataAssessment: { eligible: true, reasons: [] },
    governanceConfig,
  };
  const eligible = recoveryScopeAssessment(base);
  assert.equal(eligible.eligible, true, eligible.reasons.join('; '));
  assert.equal(eligible.ecosystem, 'npm');

  const controlPlane = recoveryScopeAssessment({
    ...base,
    pull: { changed_files: 1 },
    files: [{ filename: '.github/workflows/ci.yml' }],
  });
  assert.equal(controlPlane.eligible, false);
  assert.match(controlPlane.reasons.join('\n'), /control-plane/);

  const unknownScope = recoveryScopeAssessment({
    ...base,
    pull: { changed_files: 1 },
    files: [{ filename: 'README.md' }],
  });
  assert.equal(unknownScope.eligible, false);
  assert.match(unknownScope.reasons.join('\n'), /allowlisted dependency ecosystem/);

  const spoofed = recoveryScopeAssessment({
    ...base,
    provenance: { eligible: false, reasons: ['invalid signature'] },
  });
  assert.equal(spoofed.eligible, false);
  assert.match(spoofed.reasons.join('\n'), /invalid signature/);
});

test('Dependabot configuration explicitly preserves native auto-rebase for every update ecosystem', () => {
  const dependabot = readFileSync('.github/dependabot.yml', 'utf8');
  const ecosystems = dependabot.match(/^\s*-\s+package-ecosystem:/gmu) || [];
  const rebases = dependabot.match(/^\s*rebase-strategy:\s*auto\s*$/gmu) || [];
  assert.ok(ecosystems.length > 0, 'Dependabot must configure at least one update ecosystem');
  assert.equal(rebases.length, ecosystems.length);
});

test('recovery control plane is itself covered by governance self-test triggers', () => {
  const workflow = readFileSync('.github/workflows/dependency-governance.yml', 'utf8');
  for (const path of [
    '.github/dependency-recovery.json',
    '.github/scripts/dependency-recovery.mjs',
    '.github/scripts/dependency-recovery.selfcheck.mjs',
    '.github/dependabot.yml',
  ]) {
    assert.ok(workflow.includes(path), `${path} must trigger governance self-tests`);
  }
  assert.match(workflow, /ALLOW_RECOVERY_RERUN:/);
  assert.match(workflow, /node \.github\/scripts\/dependency-recovery\.mjs/);
  assert.match(workflow, /dependency-recovery\.selfcheck\.mjs/);
});
