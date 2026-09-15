import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const baselineWorkflow = readFileSync(
  '.github/workflows/visual-baseline.yml',
  'utf8',
);
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const governanceWorkflow = readFileSync(
  '.github/workflows/dependency-governance.yml',
  'utf8',
);
const governanceConfig = JSON.parse(
  readFileSync('.github/dependency-governance.json', 'utf8'),
);

const baselinePath = '.github/workflows/visual-baseline.yml';
const ciPath = '.github/workflows/ci.yml';
const selfcheckPath = '.github/scripts/visual-baseline-trigger.selfcheck.mjs';

test('governed main advancement regenerates an exact-head visual baseline', () => {
  assert.match(
    baselineWorkflow,
    /workflow_run:\n\s+workflows: \[dependency-governance\]\n\s+types: \[completed\]/,
  );
  assert.match(baselineWorkflow, /github\.event_name != 'workflow_run'/);
  assert.match(
    baselineWorkflow,
    /github\.event\.workflow_run\.event != 'pull_request'/,
  );
  assert.match(
    baselineWorkflow,
    /github\.sha != github\.event\.workflow_run\.head_sha/,
  );
  assert.match(baselineWorkflow, /push:\n\s+branches: \[main\]/);
});

test('visual comparison is skipped only for explicitly non-visual PR scope', () => {
  assert.match(ciWorkflow, /name: change-scope/);
  assert.match(ciWorkflow, /\.github\/\*\|docs\/\*/);
  assert.match(ciWorkflow, /visual_required=false/);
  assert.match(ciWorkflow, /\*\) visual_required=true/);
  assert.match(ciWorkflow, /needs\.changes\.outputs\.visual_required == 'true'/);
  assert.match(
    ciWorkflow,
    /VISUAL_REQUIRED: \$\{\{ needs\.changes\.outputs\.visual_required \}\}/,
  );
  assert.match(
    ciWorkflow,
    /\[\[ "\$VISUAL_REQUIRED" == "false" && "\$VISUAL" == "skipped" \]\]/,
  );
});

test('visual baseline and applicability rules remain manual-review control plane', () => {
  assert.ok(governanceConfig.manualReviewPaths.includes(baselinePath));
  assert.ok(governanceConfig.manualReviewPaths.includes(ciPath));
  assert.ok(governanceConfig.manualReviewPaths.includes(selfcheckPath));
  assert.match(governanceWorkflow, /- '\.github\/workflows\/ci\.yml'/);
  assert.match(
    governanceWorkflow,
    /- '\.github\/workflows\/visual-baseline\.yml'/,
  );
  assert.match(
    governanceWorkflow,
    /- '\.github\/scripts\/visual-baseline-trigger\.selfcheck\.mjs'/,
  );
  assert.match(
    governanceWorkflow,
    /node --test \.github\/scripts\/dependency-governance\.selfcheck\.mjs \.github\/scripts\/visual-baseline-trigger\.selfcheck\.mjs/,
  );
});
