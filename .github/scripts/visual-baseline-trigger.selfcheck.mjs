import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const baseline = read('.github/workflows/visual-baseline.yml');
const ci = read('.github/workflows/ci.yml');
const governance = read('.github/workflows/dependency-governance.yml');
const config = JSON.parse(read('.github/dependency-governance.json'));
const contains = (text, fragment) => assert.ok(text.includes(fragment));

test('governed main advancement regenerates an exact-head visual baseline', () => {
  contains(baseline, 'workflow_run:\n    workflows: [dependency-governance]');
  contains(baseline, "github.event_name != 'workflow_run'");
  contains(baseline, "github.event.workflow_run.event != 'pull_request'");
  contains(baseline, 'github.sha != github.event.workflow_run.head_sha');
  contains(baseline, 'push:\n    branches: [main]');
});

test('visual comparison is skipped only for explicitly non-visual PR scope', () => {
  contains(ci, 'name: change-scope');
  contains(ci, '.github/*|docs/*');
  contains(ci, 'visual_required=false');
  contains(ci, '*) visual_required=true');
  contains(ci, "needs.changes.outputs.visual_required == 'true'");
  contains(ci, 'VISUAL_REQUIRED: ${{ needs.changes.outputs.visual_required }}');
  contains(ci, '[[ "$VISUAL_REQUIRED" == "false"');
  contains(ci, '"$VISUAL" == "skipped" ]]');
});

test('visual baseline and applicability rules remain manual-review control plane', () => {
  const manual = config.manualReviewPaths;
  assert.ok(manual.includes('.github/workflows/visual-baseline.yml'));
  assert.ok(manual.includes('.github/workflows/ci.yml'));
  assert.ok(manual.includes('.github/scripts/visual-baseline-trigger.selfcheck.mjs'));
  contains(governance, "- '.github/workflows/ci.yml'");
  contains(governance, "- '.github/workflows/visual-baseline.yml'");
  contains(governance, "- '.github/scripts/visual-baseline-trigger.selfcheck.mjs'");
  contains(governance, 'dependency-governance.selfcheck.mjs');
  contains(governance, 'visual-baseline-trigger.selfcheck.mjs');
});
