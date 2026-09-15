import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyLeafJobFailure,
  classifyRunFailure,
  extractStepLogWindow,
  matchingNonTransientSignatures,
  matchingTransientSignatures,
  recoveryScopeAssessment,
  runDependencyRecovery,
  validateRecoveryConfig,
} from './dependency-recovery-policy.mjs';

const governanceConfig = JSON.parse(readFileSync('.github/dependency-governance.json', 'utf8'));
const recoveryConfig = JSON.parse(readFileSync('.github/dependency-recovery.json', 'utf8'));

const SUCCESS_START = '2026-09-15T12:00:00Z';
const SUCCESS_END = '2026-09-15T12:00:02Z';
const FAILURE_START = '2026-09-15T12:00:03Z';
const FAILURE_END = '2026-09-15T12:00:05Z';

const logLine = (timestamp, message) => `${timestamp} ${message}`;
const logs = ({ before = '', failed = '', after = '' } = {}) =>
  [
    logLine('2026-09-15T12:00:01.0000000Z', before),
    logLine('2026-09-15T12:00:04.0000000Z', failed),
    logLine('2026-09-15T12:00:06.0000000Z', after),
  ].join('\n');

function job({
  id = 1,
  name = 'quality',
  step = 'Install dependencies',
  conclusion = 'failure',
  startedAt = FAILURE_START,
  completedAt = FAILURE_END,
} = {}) {
  return {
    id,
    name,
    conclusion,
    steps: [
      {
        name: 'Set up job',
        conclusion: 'success',
        started_at: SUCCESS_START,
        completed_at: SUCCESS_END,
      },
      {
        name: step,
        conclusion,
        started_at: startedAt,
        completed_at: completedAt,
      },
    ],
  };
}

function gate(name = 'quality-gate', conclusion = 'failure') {
  return {
    id: 99,
    name,
    conclusion,
    steps: [
      {
        name: 'Evaluate required jobs',
        conclusion,
        started_at: FAILURE_START,
        completed_at: FAILURE_END,
      },
    ],
  };
}

function canonicalFixture() {
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const fullName = 'portyu9/fixture';
  const pull = {
    number: 41,
    state: 'open',
    user: { login: governanceConfig.botLogin, id: governanceConfig.botUserId },
    base: { ref: governanceConfig.baseBranch, repo: { full_name: fullName } },
    head: {
      ref: 'dependabot/npm_and_yarn/routine',
      repo: { full_name: fullName },
      sha: headSha,
    },
    draft: false,
    labels: [],
    created_at: new Date().toISOString(),
    commits: 1,
    changed_files: 2,
  };
  const commit = {
    sha: headSha,
    author: { login: governanceConfig.botLogin, id: governanceConfig.botUserId },
    committer: { login: governanceConfig.trustedCommitterLogin },
    commit: {
      author: { name: governanceConfig.botLogin, email: governanceConfig.botAuthorEmail },
      committer: {
        name: governanceConfig.gitCommitterName,
        email: governanceConfig.gitCommitterEmail,
      },
      verification: { verified: true, reason: 'valid', signature: 'fixture-signature' },
      message: `deps(deps): bump fixture\n\nupdated-dependencies:\n- dependency-name: fixture\n  dependency-version: 1.2.4\n  dependency-type: direct:development\n  update-type: version-update:semver-patch\n...\n\n${governanceConfig.signedOffBy}`,
    },
    parents: [{ sha: baseSha }],
  };
  return { baseSha, headSha, pull, commit };
}

function fakeGithub({
  pull,
  commit,
  baseSha,
  files = [{ filename: 'package.json' }, { filename: 'package-lock.json' }],
  run,
  jobs,
  jobLog,
} = {}) {
  const reruns = [];
  const api = {
    rest: {
      git: {
        getRef: async () => ({ data: { object: { sha: baseSha } } }),
      },
      pulls: {
        get: async () => ({ data: pull }),
        listCommits: async () => ({ data: [commit] }),
        listFiles: async () => ({ data: files }),
        list: async () => ({ data: [pull] }),
      },
      actions: {
        listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: run ? [run] : [] } }),
        listJobsForWorkflowRun: async () => ({ data: { jobs: jobs || [] } }),
      },
    },
    request: async (route, params) => {
      if (route.startsWith('GET ')) return { data: jobLog || '' };
      if (route.startsWith('POST ')) {
        reruns.push(params.run_id);
        return { data: null };
      }
      throw new Error(`unexpected route ${route}`);
    },
  };
  return { api, reruns };
}

function runFixture({
  conclusion = 'failure',
  attempt = 1,
  workflow = governanceConfig.requiredWorkflows[0],
  headSha = 'b'.repeat(40),
  headBranch = 'dependabot/npm_and_yarn/routine',
} = {}) {
  return {
    id: 501,
    name: workflow.workflow,
    path: `.github/workflows/${workflow.file}`,
    event: 'pull_request',
    head_sha: headSha,
    head_branch: headBranch,
    pull_requests: [{ number: 41 }],
    status: 'completed',
    conclusion,
    run_attempt: attempt,
    updated_at: '2026-09-15T12:00:10Z',
  };
}

function contextFixture(pull) {
  return {
    eventName: 'workflow_run',
    repo: { owner: 'portyu9', repo: 'fixture' },
    payload: {
      workflow_run: {
        pull_requests: [{ number: pull.number }],
        head_branch: pull.head.ref,
      },
    },
  };
}

const coreFixture = () => ({
  messages: [],
  info(message) {
    this.messages.push(message);
  },
});

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
  assert.ok(validateRecoveryConfig({ ...recoveryConfig, maxRunAttempts: 4 }).length > 0);
});

test('signature model is narrow and deterministic evidence outranks transient words', () => {
  assert.deepEqual(matchingTransientSignatures('npm error code EAI_AGAIN'), ['dns-eai-again']);
  assert.deepEqual(matchingTransientSignatures('request failed with status code 503'), [
    'http-5xx',
  ]);
  assert.deepEqual(matchingTransientSignatures('503 Service Unavailable'), [
    'gateway-service-outage',
  ]);
  assert.deepEqual(matchingTransientSignatures('Service Unavailable'), []);
  assert.deepEqual(matchingTransientSignatures('502 vulnerabilities found'), []);
  assert.deepEqual(matchingNonTransientSignatures('npm error code ERESOLVE'), ['npm-resolution']);
  assert.deepEqual(matchingNonTransientSignatures('HTTP 403'), ['http-client-or-policy']);
  assert.deepEqual(matchingNonTransientSignatures('npm error code ENOSPC'), ['disk-space']);
});

test('only timestamp-bounded failed-step logs can authorize recovery', () => {
  const candidate = job();
  const window = extractStepLogWindow(
    logs({
      before: 'npm error code EAI_AGAIN',
      failed: 'npm error code ERESOLVE',
      after: '503 Service Unavailable',
    }),
    candidate.steps[1],
  );
  assert.match(window, /ERESOLVE/);
  assert.doesNotMatch(window, /EAI_AGAIN/);
  assert.doesNotMatch(window, /Service Unavailable/);

  const result = classifyLeafJobFailure(
    candidate,
    logs({ before: 'npm error code EAI_AGAIN', failed: 'npm error code ERESOLVE' }),
    recoveryConfig,
  );
  assert.equal(result.transient, false);
  assert.match(result.reason, /deterministic or policy-blocking/);
});

test('allowlisted infrastructure step plus its own precise transient evidence is retryable', () => {
  const result = classifyLeafJobFailure(
    job(),
    logs({ failed: 'npm error code ECONNRESET' }),
    recoveryConfig,
  );
  assert.equal(result.transient, true, result.reason);
  assert.deepEqual(result.signatures, ['connection-reset']);
});

test('deterministic blocker wins even if the same failed step also contains transient evidence', () => {
  const result = classifyLeafJobFailure(
    job(),
    logs({ failed: 'npm error code EAI_AGAIN then npm error code ERESOLVE' }),
    recoveryConfig,
  );
  assert.equal(result.transient, false);
  assert.deepEqual(result.blockers, ['npm-resolution']);
});

test('missing or malformed step timestamps fail closed', () => {
  for (const candidate of [
    job({ startedAt: null }),
    job({ completedAt: null }),
    job({ startedAt: 'not-a-date' }),
    job({ startedAt: FAILURE_END, completedAt: FAILURE_START }),
  ]) {
    const result = classifyLeafJobFailure(
      candidate,
      logs({ failed: 'npm error code EAI_AGAIN' }),
      recoveryConfig,
    );
    assert.equal(result.transient, false);
    assert.match(result.reason, /timestamp-bounded log window/);
  }
});

test('functional and security findings remain non-retryable even with transient-looking text', () => {
  for (const step of [
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
  ]) {
    const result = classifyLeafJobFailure(
      job({ step }),
      logs({ failed: 'ETIMEDOUT EAI_AGAIN 503 Service Unavailable' }),
      recoveryConfig,
    );
    assert.equal(result.transient, false, step);
  }
});

test('run recovery requires exactly one failed stable gate and no ambiguous siblings', () => {
  const run = { status: 'completed', conclusion: 'failure', run_attempt: 1 };
  const transient = job({ id: 10 });
  const positive = classifyRunFailure({
    run,
    jobs: [transient, gate()],
    logsByJobId: { 10: logs({ failed: 'npm error code EAI_AGAIN' }) },
    gateName: 'quality-gate',
    recoveryConfig,
  });
  assert.equal(positive.rerunnable, true, positive.reason);

  for (const conclusion of [
    'cancelled',
    'timed_out',
    'neutral',
    'action_required',
    'stale',
    null,
  ]) {
    const result = classifyRunFailure({
      run,
      jobs: [transient, { id: 20, name: 'sibling', conclusion, steps: [] }, gate()],
      logsByJobId: { 10: logs({ failed: 'npm error code EAI_AGAIN' }) },
      gateName: 'quality-gate',
      recoveryConfig,
    });
    assert.equal(result.rerunnable, false, String(conclusion));
    assert.match(result.reason, /ambiguous terminal state/);
  }

  for (const gateConclusion of ['success', 'skipped', 'cancelled', 'timed_out']) {
    const result = classifyRunFailure({
      run,
      jobs: [transient, gate('quality-gate', gateConclusion)],
      logsByJobId: { 10: logs({ failed: 'npm error code EAI_AGAIN' }) },
      gateName: 'quality-gate',
      recoveryConfig,
    });
    assert.equal(result.rerunnable, false);
    assert.match(result.reason, /stable aggregate gate/);
  }
});

test('recovery is capped at one automatic rerun and ambiguous workflow conclusions fail closed', () => {
  const transient = job({ id: 10 });
  const result = classifyRunFailure({
    run: { status: 'completed', conclusion: 'failure', run_attempt: 2 },
    jobs: [transient, gate()],
    logsByJobId: { 10: logs({ failed: 'npm error code EAI_AGAIN' }) },
    gateName: 'quality-gate',
    recoveryConfig,
  });
  assert.equal(result.rerunnable, false);
  assert.match(result.reason, /reached recovery cap/);

  for (const conclusion of ['cancelled', 'timed_out', 'action_required', 'stale']) {
    const blocked = classifyRunFailure({
      run: { status: 'completed', conclusion, run_attempt: 1 },
      jobs: [transient, gate()],
      logsByJobId: { 10: logs({ failed: 'npm error code EAI_AGAIN' }) },
      gateName: 'quality-gate',
      recoveryConfig,
    });
    assert.equal(blocked.rerunnable, false, conclusion);
  }
});

test('scope requires canonical provenance, signed metadata, an allowlisted ecosystem, and no control-plane path', () => {
  const base = {
    pull: { changed_files: 2 },
    files: [{ filename: 'package.json' }, { filename: 'package-lock.json' }],
    provenance: { eligible: true, reasons: [] },
    metadataAssessment: { eligible: true, reasons: [] },
    governanceConfig,
  };
  assert.equal(recoveryScopeAssessment(base).eligible, true);
  assert.equal(
    recoveryScopeAssessment({
      ...base,
      pull: { changed_files: 1 },
      files: [{ filename: '.github/workflows/ci.yml' }],
    }).eligible,
    false,
  );
  assert.equal(
    recoveryScopeAssessment({
      ...base,
      pull: { changed_files: 1 },
      files: [{ filename: 'README.md' }],
    }).eligible,
    false,
  );
});

test('injected-client orchestration requests exactly one rerun for a canonical transient failure', async () => {
  const fixture = canonicalFixture();
  const requirement = governanceConfig.requiredWorkflows[0];
  const workflowRun = runFixture({
    workflow: requirement,
    headSha: fixture.headSha,
    headBranch: fixture.pull.head.ref,
  });
  const transientJob = job({ id: 10, step: recoveryConfig.transientSteps[0] });
  const { api, reruns } = fakeGithub({
    ...fixture,
    run: workflowRun,
    jobs: [transientJob, gate(requirement.gate)],
    jobLog: logs({ failed: 'npm error code EAI_AGAIN' }),
  });
  const result = await runDependencyRecovery({
    github: api,
    context: contextFixture(fixture.pull),
    core: coreFixture(),
    allowRerun: true,
  });
  assert.deepEqual(reruns, [workflowRun.id]);
  assert.equal(result.actions[0].state, 'rerun-requested');
});

test('injected-client orchestration never reruns contaminated, stale, or ambiguous failures', async () => {
  const requirement = governanceConfig.requiredWorkflows[0];

  {
    const fixture = canonicalFixture();
    const { api, reruns } = fakeGithub({
      ...fixture,
      run: runFixture({
        workflow: requirement,
        headSha: fixture.headSha,
        headBranch: fixture.pull.head.ref,
      }),
      jobs: [job({ id: 10, step: recoveryConfig.transientSteps[0] }), gate(requirement.gate)],
      jobLog: logs({ before: 'npm error code EAI_AGAIN', failed: 'npm error code ERESOLVE' }),
    });
    await runDependencyRecovery({
      github: api,
      context: contextFixture(fixture.pull),
      core: coreFixture(),
      allowRerun: true,
    });
    assert.deepEqual(reruns, []);
  }

  {
    const fixture = canonicalFixture();
    const { api, reruns } = fakeGithub({
      ...fixture,
      baseSha: 'c'.repeat(40),
      run: runFixture({
        workflow: requirement,
        headSha: fixture.headSha,
        headBranch: fixture.pull.head.ref,
      }),
      jobs: [job({ id: 10, step: recoveryConfig.transientSteps[0] }), gate(requirement.gate)],
      jobLog: logs({ failed: 'npm error code EAI_AGAIN' }),
    });
    const result = await runDependencyRecovery({
      github: api,
      context: contextFixture(fixture.pull),
      core: coreFixture(),
      allowRerun: true,
    });
    assert.deepEqual(reruns, []);
    assert.match(result.reason, /auto-rebase/);
  }

  {
    const fixture = canonicalFixture();
    const { api, reruns } = fakeGithub({
      ...fixture,
      run: runFixture({
        workflow: requirement,
        headSha: fixture.headSha,
        headBranch: fixture.pull.head.ref,
      }),
      jobs: [
        job({ id: 10, step: recoveryConfig.transientSteps[0] }),
        { id: 20, name: 'sibling', conclusion: 'timed_out', steps: [] },
        gate(requirement.gate),
      ],
      jobLog: logs({ failed: 'npm error code EAI_AGAIN' }),
    });
    await runDependencyRecovery({
      github: api,
      context: contextFixture(fixture.pull),
      core: coreFixture(),
      allowRerun: true,
    });
    assert.deepEqual(reruns, []);
  }
});

test('dry-run mode can explain a safe recovery without mutating Actions state', async () => {
  const fixture = canonicalFixture();
  const requirement = governanceConfig.requiredWorkflows[0];
  const workflowRun = runFixture({
    workflow: requirement,
    headSha: fixture.headSha,
    headBranch: fixture.pull.head.ref,
  });
  const { api, reruns } = fakeGithub({
    ...fixture,
    run: workflowRun,
    jobs: [job({ id: 10, step: recoveryConfig.transientSteps[0] }), gate(requirement.gate)],
    jobLog: logs({ failed: 'npm error code EAI_AGAIN' }),
  });
  const result = await runDependencyRecovery({
    github: api,
    context: contextFixture(fixture.pull),
    core: coreFixture(),
    allowRerun: false,
  });
  assert.deepEqual(reruns, []);
  assert.equal(result.actions[0].state, 'dry-run');
});

test('Dependabot auto-rebase and recovery workflow wiring stay protected by self-tests', () => {
  const dependabot = readFileSync('.github/dependabot.yml', 'utf8');
  const ecosystems = dependabot.match(/^\s*-\s+package-ecosystem:/gmu) || [];
  const rebases = dependabot.match(/^\s*rebase-strategy:\s*auto\s*$/gmu) || [];
  assert.ok(ecosystems.length > 0);
  assert.equal(rebases.length, ecosystems.length);

  const workflow = readFileSync('.github/workflows/dependency-governance.yml', 'utf8');
  for (const path of [
    '.github/dependency-recovery.json',
    '.github/scripts/dependency-recovery-policy.mjs',
    '.github/scripts/dependency-recovery-policy.selfcheck.mjs',
    '.github/dependabot.yml',
  ]) {
    assert.ok(workflow.includes(path), `${path} must trigger governance self-tests`);
  }
  assert.match(workflow, /actions\/github-script@[0-9a-f]{40}/u);
  assert.match(workflow, /runDependencyRecovery/u);
  assert.match(workflow, /dependency-recovery-policy\.selfcheck\.mjs/u);
});


test('ReDoS-sensitive matchers stay line-local and deterministic', () => {
  assert.deepEqual(matchingNonTransientSignatures('package.json and package-lock.json are not in sync'), ['npm-lock-mismatch']);
  assert.deepEqual(matchingNonTransientSignatures('npm ci requires a lockfile for this install'), ['npm-lock-mismatch']);
  assert.deepEqual(matchingNonTransientSignatures('package.json\npackage-lock.json is not in sync'), []);
  assert.deepEqual(matchingTransientSignatures('TLS handshake connection timed out'), ['tls-transient']);
  assert.deepEqual(matchingTransientSignatures('TLS handshake\nconnection timed out'), []);
  const large = `TLS ${'x'.repeat(250_000)} connection timeout`;
  assert.deepEqual(matchingTransientSignatures(large), ['tls-transient']);
});
