import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const config = JSON.parse(fs.readFileSync('.github/codeql-autofix.json', 'utf8'));
const governance = JSON.parse(fs.readFileSync('.github/dependency-governance.json', 'utf8'));
const workflow = fs.readFileSync('.github/workflows/codeql-autofix.yml', 'utf8');

const controllerSha = '9280e1cf79bea79c027eabc8abe355ad89e6c010';
const controllerRepo = 'portyu9/qa-automation-mobile-appium';

function sorted(values) {
  return [...values].sort();
}

test('caller targets only the requested Visual alerts with bounded scope', () => {
  assert.deepEqual(config.targetAlertNumbers, [2, 3]);
  assert.equal(config.maxAlertsPerRun, 2);
  assert.equal(config.maxChangedFiles, 4);
  assert.equal(config.maxChangedLines, 200);
  assert.equal(config.defaultBranch, 'main');
  assert.equal(config.toolName, 'CodeQL');
});

test('caller qualification workflows exactly mirror dependency governance', () => {
  const required = governance.requiredWorkflows.map((item) => item.file);
  assert.deepEqual(sorted(config.qualificationWorkflows), sorted(required));
});

test('autofix cannot modify repository control plane or dependency manifests', () => {
  for (const denied of [
    '.github/workflows/',
    '.github/dependabot.yml',
    '.github/dependency-governance.json',
    '.github/dependency-recovery.json',
    '.github/codeql-autofix.json',
    'package.json',
    'package-lock.json',
    'Dockerfile',
  ]) {
    assert.ok(config.deniedPaths.includes(denied), `${denied} must stay denied`);
  }
});

test('wrapper pins the canonical controller and all external actions immutably', () => {
  assert.match(workflow, new RegExp(`repository: ${controllerRepo.replaceAll('/', '\\/')}`));
  const pinMatches = workflow.match(new RegExp(`ref: ${controllerSha}`, 'g')) || [];
  assert.equal(pinMatches.length, 2);
  for (const match of workflow.matchAll(/uses:\s+([^\s#]+)/g)) {
    const spec = match[1];
    assert.match(spec, /@[0-9a-f]{40}$/u, `workflow dependency is not SHA pinned: ${spec}`);
  }
});

test('capitalized Security trigger is normalized only for canonical-controller compatibility', () => {
  assert.match(workflow, /workflows: \[Security\]/u);
  assert.match(workflow, /github\.event\.workflow_run\.name == 'Security'/u);
  assert.match(
    workflow,
    /workflow_run: \{ \.\.\.context\.payload\.workflow_run, name: 'security' \}/u,
  );
});

test('workflow_run normalization preserves github-script repository context', () => {
  assert.match(workflow, /\.\.\.context,\s+repo: context\.repo,\s+payload:/u);
  assert.doesNotMatch(workflow, /\.\.\.context,\s+payload:/u);
});

test('privileged proposal job is impossible on pull_request', () => {
  assert.match(workflow, /propose-fixes:[\s\S]*github\.event_name == 'schedule'/u);
  assert.doesNotMatch(workflow, /propose-fixes:[\s\S]*github\.event_name == 'pull_request'/u);
  assert.match(workflow, /security-events: write/u);
  assert.match(workflow, /pull-requests: write/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /actions: write/u);
});

test('privileged execution checks out trusted main and imports only canonical controller code', () => {
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(
    workflow,
    /\.codeql-autofix-controller\/\.github\/scripts\/codeql-autofix-policy\.mjs/u,
  );
});

test('autofix control plane is protected from autonomous dependency updates', () => {
  for (const protectedPath of [
    '.github/codeql-autofix.json',
    '.github/workflows/codeql-autofix.yml',
    '.github/scripts/codeql-autofix-wrapper.selfcheck.mjs',
  ]) {
    assert.ok(
      governance.manualReviewPaths.includes(protectedPath),
      `${protectedPath} must require manual review`,
    );
  }
});
