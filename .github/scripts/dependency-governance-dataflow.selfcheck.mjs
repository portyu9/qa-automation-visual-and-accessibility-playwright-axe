import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  normalizeDependabotHeadBranch,
  targetPullNumberFromEnvironment,
} from './dependency-governance.mjs';

test('event-derived governance inputs are independently bounded', () => {
  assert.equal(
    targetPullNumberFromEnvironment('workflow_dispatch', { TARGET_PR_NUMBER: '41' }),
    41,
  );
  assert.equal(targetPullNumberFromEnvironment('workflow_run', { TARGET_PR_NUMBER: '' }), null);
  for (const value of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
    assert.throws(() =>
      targetPullNumberFromEnvironment('workflow_run', { TARGET_PR_NUMBER: value }),
    );
  }

  assert.equal(
    normalizeDependabotHeadBranch('dependabot/npm_and_yarn/routine-dependencies-123'),
    'dependabot/npm_and_yarn/routine-dependencies-123',
  );
  assert.equal(normalizeDependabotHeadBranch('feature/not-dependabot'), null);
  for (const value of [
    'dependabot/npm_and_yarn/bad branch',
    'dependabot/npm_and_yarn/a..b',
    'dependabot//npm_and_yarn/a',
    'dependabot/npm_and_yarn/a@{b',
    'dependabot/npm_and_yarn/a.lock',
  ]) {
    assert.throws(() => normalizeDependabotHeadBranch(value));
  }
});

test('privileged governance implementation has no local-file-to-network source path', () => {
  const source = readFileSync('.github/scripts/dependency-governance.mjs', 'utf8');
  assert.doesNotMatch(source, /node:fs/u);
  assert.doesNotMatch(source, /readFileSync/u);
  assert.doesNotMatch(source, /GITHUB_EVENT_PATH/u);
  assert.doesNotMatch(source, /GOVERNANCE_CONFIG/u);
  assert.match(
    source,
    /import governanceConfig from '\.\.\/dependency-governance\.json' with \{ type: 'json' \}/u,
  );
});

test('privileged workflow projects only bounded scalar event inputs', () => {
  const workflow = readFileSync('.github/workflows/dependency-governance.yml', 'utf8');
  assert.match(workflow, /TARGET_PR_NUMBER:/u);
  assert.match(workflow, /WORKFLOW_RUN_HEAD_BRANCH:/u);
  assert.doesNotMatch(workflow, /GITHUB_EVENT_PATH:/u);
  assert.doesNotMatch(workflow, /GOVERNANCE_CONFIG:/u);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/u);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/u);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha/u);
});
