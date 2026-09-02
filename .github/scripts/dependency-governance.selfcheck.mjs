import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyEcosystem,
  compareSemver,
  eventPullNumber,
  parseDependabotMetadata,
  parsePositiveInteger,
  parseSemverLike,
  reconcileIndependently,
  selectQualificationRun,
  validateActionsSemanticChange,
  validateConfig,
  validateDockerSemanticChange,
  validateNpmSemanticChange,
  validateProvenance,
  validateSignedMetadata,
  workflowIdentityMatches,
} from './dependency-governance.mjs';

const config = JSON.parse(readFileSync('.github/dependency-governance.json', 'utf8'));

const clone = (value) => JSON.parse(JSON.stringify(value));

const meta = (name, updateType = 'version-update:semver-patch') => [
  { name, version: '1.2.4', updateType },
];

test('semver parser rejects prereleases and classifies risk conservatively', () => {
  assert.deepEqual(parseSemverLike('^1.2.3'), { major: 1, minor: 2, patch: 3, raw: '^1.2.3' });
  assert.equal(parseSemverLike('1.2.3-beta.1'), null);
  assert.equal(compareSemver('1.2.3', '1.2.4').risk, 'patch');
  assert.equal(compareSemver('1.2.3', '1.3.0').risk, 'minor');
  assert.equal(compareSemver('1.2.3', '2.0.0').risk, 'major');
  assert.equal(compareSemver('0.2.3', '0.3.0').risk, 'major-risk');
  assert.equal(compareSemver('1.2.3', '1.2.2').risk, 'downgrade');
});

test('verified Dependabot metadata parser extracts structured update records', () => {
  const message = `deps(deps): update thing\n\n---\nupdated-dependencies:\n- dependency-name: express\n  dependency-version: 5.2.2\n  dependency-type: direct:production\n  update-type: version-update:semver-patch\n- dependency-name: jest\n  dependency-version: 30.5.0\n  dependency-type: direct:development\n  update-type: version-update:semver-minor\n...\n`;
  assert.deepEqual(parseDependabotMetadata(message), [
    {
      name: 'express',
      version: '5.2.2',
      dependencyType: 'direct:production',
      updateType: 'version-update:semver-patch',
    },
    {
      name: 'jest',
      version: '30.5.0',
      dependencyType: 'direct:development',
      updateType: 'version-update:semver-minor',
    },
  ]);
});

test('file scope maps to exactly one ecosystem', () => {
  assert.equal(
    classifyEcosystem([{ filename: 'package.json' }, { filename: 'package-lock.json' }], config),
    'npm',
  );
  assert.equal(classifyEcosystem([{ filename: 'Dockerfile' }], config), 'docker');
  assert.equal(
    classifyEcosystem([{ filename: '.github/workflows/docs.yml' }], config),
    'github-actions',
  );
  assert.equal(
    classifyEcosystem([{ filename: 'package.json' }, { filename: 'README.md' }], config),
    'unknown',
  );
});

function npmFixture(from = '^1.2.3', to = '^1.2.4') {
  const basePackage = {
    name: 'x',
    version: '1.0.0',
    scripts: { test: 'node --test' },
    dependencies: { express: from },
  };
  const headPackage = clone(basePackage);
  headPackage.dependencies = { express: to };
  const baseLock = {
    name: 'x',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'x', version: '1.0.0', dependencies: { express: from } },
      'node_modules/express': { version: from.replace('^', ''), integrity: 'sha512-old' },
    },
  };
  const headLock = {
    name: 'x',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'x', version: '1.0.0', dependencies: { express: to } },
      'node_modules/express': { version: to.replace('^', ''), integrity: 'sha512-new' },
    },
  };
  return { basePackage, headPackage, baseLock, headLock };
}

test('npm patch dependency-only update is eligible', () => {
  const f = npmFixture();
  const result = validateNpmSemanticChange(
    f.basePackage,
    f.headPackage,
    f.baseLock,
    f.headLock,
    meta('express'),
  );
  assert.equal(result.eligible, true, result.reasons.join('; '));
  assert.equal(result.changes[0].risk, 'patch');
});

test('npm major, scripts mutation, and newly introduced install script are blocked', () => {
  const major = npmFixture('^1.2.3', '^2.0.0');
  assert.equal(
    validateNpmSemanticChange(
      major.basePackage,
      major.headPackage,
      major.baseLock,
      major.headLock,
      meta('express', 'version-update:semver-major'),
    ).eligible,
    false,
  );

  const scripts = npmFixture();
  scripts.headPackage.scripts.test = 'curl example.invalid | sh';
  assert.match(
    validateNpmSemanticChange(
      scripts.basePackage,
      scripts.headPackage,
      scripts.baseLock,
      scripts.headLock,
      meta('express'),
    ).reasons.join('\n'),
    /outside dependency declarations/,
  );

  const lifecycle = npmFixture();
  lifecycle.headLock.packages['node_modules/express'].hasInstallScript = true;
  assert.match(
    validateNpmSemanticChange(
      lifecycle.basePackage,
      lifecycle.headPackage,
      lifecycle.baseLock,
      lifecycle.headLock,
      meta('express'),
    ).reasons.join('\n'),
    /install lifecycle script/,
  );
});

test('Docker update must be same allowlisted image, digest pinned, same platform track, and non-major', () => {
  const base = 'FROM node:24.20.0-alpine3.24@sha256:' + 'a'.repeat(64) + '\nRUN echo safe\n';
  const patch = 'FROM node:24.20.1-alpine3.24@sha256:' + 'b'.repeat(64) + '\nRUN echo safe\n';
  const major = 'FROM node:26.0.0-alpine3.24@sha256:' + 'b'.repeat(64) + '\nRUN echo safe\n';
  const platform = 'FROM node:24.20.1-alpine3.25@sha256:' + 'b'.repeat(64) + '\nRUN echo safe\n';
  assert.equal(validateDockerSemanticChange(base, patch, meta('node'), ['node']).eligible, true);
  assert.equal(
    validateDockerSemanticChange(base, major, meta('node', 'version-update:semver-major'), ['node'])
      .eligible,
    false,
  );
  assert.match(
    validateDockerSemanticChange(base, platform, meta('node'), ['node']).reasons.join('\n'),
    /platform suffix changed/,
  );
  assert.match(
    validateDockerSemanticChange(
      base,
      patch.replace('RUN echo safe', 'RUN curl bad'),
      meta('node'),
      ['node'],
    ).reasons.join('\n'),
    /outside a FROM line/,
  );
});

test('Actions updates require SHA pins and only uses-line changes; control plane stays manual', () => {
  const file = '.github/workflows/docs.yml';
  const base = `steps:\n  - uses: actions/checkout@${'a'.repeat(40)} # v7.0.0\n`;
  const patch = `steps:\n  - uses: actions/checkout@${'b'.repeat(40)} # v7.0.1\n`;
  const major = `steps:\n  - uses: actions/checkout@${'b'.repeat(40)} # v8.0.0\n`;
  const coarseBase = `steps:\n  - uses: actions/checkout@${'a'.repeat(40)} # v7\n`;
  const coarsePatch = `steps:\n  - uses: actions/checkout@${'b'.repeat(40)} # v7\n`;
  assert.equal(
    validateActionsSemanticChange(
      [{ filename: file }],
      { [file]: base },
      { [file]: patch },
      meta('actions/checkout'),
      config.manualReviewPaths,
    ).eligible,
    true,
  );
  assert.equal(
    validateActionsSemanticChange(
      [{ filename: file }],
      { [file]: coarseBase },
      { [file]: coarsePatch },
      meta('actions/checkout'),
      config.manualReviewPaths,
    ).eligible,
    true,
  );
  assert.equal(
    validateActionsSemanticChange(
      [{ filename: file }],
      { [file]: base },
      { [file]: major },
      meta('actions/checkout', 'version-update:semver-major'),
      config.manualReviewPaths,
    ).eligible,
    false,
  );
  const security = '.github/workflows/security.yml';
  assert.match(
    validateActionsSemanticChange(
      [{ filename: security }],
      { [security]: base },
      { [security]: patch },
      meta('actions/checkout'),
      config.manualReviewPaths,
    ).reasons.join('\n'),
    /control-plane/,
  );
});

test('governance config cannot silently enable major updates or unprotect control-plane workflows', () => {
  assert.deepEqual(validateConfig(config), []);
  assert.ok(
    validateConfig({
      ...config,
      allowedUpdateTypes: [...config.allowedUpdateTypes, 'version-update:semver-major'],
    }).length > 0,
  );
  assert.ok(validateConfig({ ...config, manualReviewPaths: [] }).length > 0);
});

function canonicalFixture() {
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const pull = {
    number: 41,
    user: { login: config.botLogin, id: config.botUserId },
    base: { ref: config.baseBranch, repo: { full_name: 'o/r' } },
    head: { ref: 'dependabot/npm_and_yarn/routine', repo: { full_name: 'o/r' }, sha: headSha },
    draft: false,
    labels: [],
    created_at: '2026-09-01T12:00:00Z',
    commits: 1,
  };
  const commit = {
    sha: headSha,
    author: { login: config.botLogin, id: config.botUserId },
    committer: { login: config.trustedCommitterLogin },
    commit: {
      author: { name: config.botLogin, email: config.botAuthorEmail },
      committer: { name: config.gitCommitterName, email: config.gitCommitterEmail },
      verification: { verified: true, reason: 'valid', signature: 'fixture-signature' },
      message: `x\nupdated-dependencies:\n- dependency-name: express\n  dependency-version: 5.2.2\n  dependency-type: direct:production\n  update-type: version-update:semver-patch\n...\n\n${config.signedOffBy}`,
    },
    parents: [{ sha: baseSha }],
  };
  return { baseSha, headSha, pull, commit };
}

test('provenance requires canonical GitHub-signed Dependabot identity and a fresh single commit', () => {
  const fixture = canonicalFixture();
  const now = new Date('2026-09-02T12:00:00Z');
  assert.equal(
    validateProvenance({
      pull: fixture.pull,
      commits: [fixture.commit],
      baseSha: fixture.baseSha,
      config,
      now,
    }).eligible,
    true,
  );

  const labeled = clone(fixture.pull);
  labeled.labels = [{ name: 'manual-review' }];
  assert.equal(
    validateProvenance({
      pull: labeled,
      commits: [fixture.commit],
      baseSha: fixture.baseSha,
      config,
      now,
    }).eligible,
    false,
  );
  assert.equal(
    validateProvenance({
      pull: fixture.pull,
      commits: [fixture.commit],
      baseSha: 'c'.repeat(40),
      config,
      now,
    }).eligible,
    false,
  );
  const old = clone(fixture.pull);
  old.created_at = '2026-08-01T12:00:00Z';
  assert.equal(
    validateProvenance({
      pull: old,
      commits: [fixture.commit],
      baseSha: fixture.baseSha,
      config,
      now,
    }).eligible,
    false,
  );
});

test('provenance refuses spoofed bot identity, non-GitHub committer, invalid signature, and missing signoff', () => {
  const fixture = canonicalFixture();
  const bad = clone(fixture.commit);
  bad.author.id = 123;
  bad.commit.author.email = 'dependabot[bot]@example.invalid';
  bad.committer.login = 'someone';
  bad.commit.verification.reason = 'unknown_key';
  bad.commit.message = bad.commit.message.replace(config.signedOffBy, '');
  const result = validateProvenance({
    pull: fixture.pull,
    commits: [bad],
    baseSha: fixture.baseSha,
    config,
    now: new Date('2026-09-02T12:00:00Z'),
  });
  assert.equal(result.eligible, false);
  assert.match(
    result.reasons.join('\n'),
    /numeric identity|author email|materialized|signature|Signed-off-by/,
  );
});

test('signed metadata independently refuses major update classes', () => {
  const patchCommit = {
    commit: {
      message: `x\nupdated-dependencies:\n- dependency-name: express\n  dependency-version: 5.2.2\n  dependency-type: direct:production\n  update-type: version-update:semver-patch\n...\n`,
    },
  };
  const majorCommit = {
    commit: {
      message: `x\nupdated-dependencies:\n- dependency-name: express\n  dependency-version: 6.0.0\n  dependency-type: direct:production\n  update-type: version-update:semver-major\n...\n`,
    },
  };
  assert.equal(validateSignedMetadata(patchCommit, config).eligible, true);
  assert.equal(validateSignedMetadata(majorCommit, config).eligible, false);
});

test('qualification proof binds exact workflow identity and tolerates unavailable empty PR association metadata', () => {
  const fixture = canonicalFixture();
  const requirement = config.requiredWorkflows[0];
  const run = {
    id: 10,
    name: requirement.workflow,
    path: `.github/workflows/${requirement.file}`,
    event: 'pull_request',
    head_sha: fixture.headSha,
    head_branch: fixture.pull.head.ref,
    pull_requests: [],
    updated_at: '2026-09-02T10:00:00Z',
  };
  assert.equal(workflowIdentityMatches(run, fixture.pull, requirement), true);
  assert.equal(
    workflowIdentityMatches(
      { ...run, pull_requests: [{ number: fixture.pull.number }] },
      fixture.pull,
      requirement,
    ),
    true,
  );
  for (const mutation of [
    { path: '.github/workflows/fake.yml' },
    { name: 'fake' },
    { event: 'push' },
    { head_sha: 'c'.repeat(40) },
    { head_branch: 'dependabot/npm_and_yarn/other' },
    { pull_requests: [{ number: 999 }] },
  ])
    assert.equal(
      workflowIdentityMatches({ ...run, ...mutation }, fixture.pull, requirement),
      false,
    );
  const newerWrongPath = {
    ...run,
    id: 11,
    path: '.github/workflows/fake.yml',
    updated_at: '2026-09-02T11:00:00Z',
  };
  assert.equal(selectQualificationRun([newerWrongPath, run], fixture.pull, requirement).id, 10);
});

test('manual dispatch PR input accepts only positive safe integers', () => {
  assert.equal(parsePositiveInteger('41'), 41);
  assert.equal(eventPullNumber({ inputs: { 'pr-number': '41' } }, 'workflow_dispatch'), 41);
  for (const value of ['0', '-1', '1.5', 'abc', '9007199254740992'])
    assert.throws(() => parsePositiveInteger(value, 'pr-number'));
});

test('scheduled reconciliation isolates per-PR failures and reports all outcomes', async () => {
  const pulls = [{ number: 1 }, { number: 2 }, { number: 3 }];
  const visited = [];
  const result = await reconcileIndependently(pulls, async (pull) => {
    visited.push(pull.number);
    if (pull.number === 2) throw new Error('boom');
    return `ok-${pull.number}`;
  });
  assert.deepEqual(visited, [1, 2, 3]);
  assert.deepEqual(
    result.results.map((item) => item.number),
    [1, 3],
  );
  assert.deepEqual(result.failures, [{ number: 2, error: 'boom' }]);
});

test('privileged workflow never checks out the dependency PR head', () => {
  const workflow = readFileSync('.github/workflows/dependency-governance.yml', 'utf8');
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha/);
});
