import { readFileSync, statSync } from 'node:fs';

const governedByToken = new Map([
  [
    'framework/config.contract.spec.ts',
    [
      [
        'framework/config.contract.spec.ts',
        'runtime configuration contract › accepts valid ports and rejects partial or out-of-range values',
      ],
      [
        'framework/config.contract.spec.ts',
        'runtime configuration contract › defaults to the deterministic loopback target',
      ],
      [
        'framework/config.contract.spec.ts',
        'runtime configuration contract › accepts absolute http and https targets without hidden URL state',
      ],
      [
        'framework/config.contract.spec.ts',
        'runtime configuration contract › rejects unsupported schemes, embedded credentials, query strings, and fragments',
      ],
      [
        'framework/server.contract.spec.ts',
        'deterministic fixture server contract › rejects partially numeric ports instead of silently truncating them',
      ],
      [
        'framework/server.contract.spec.ts',
        'deterministic fixture server contract › serves only contained fixture files with defensive response headers',
      ],
    ],
  ],
  [
    'accessibility/',
    [
      [
        'accessibility/components.a11y.spec.ts',
        'component accessibility states › passes automated checks in the default state',
      ],
      [
        'accessibility/components.a11y.spec.ts',
        'component accessibility states › keeps tabs operable with arrow keys and synchronized state',
      ],
      [
        'accessibility/components.a11y.spec.ts',
        'component accessibility states › passes automated checks while the modal dialog is open',
      ],
      [
        'accessibility/components.a11y.spec.ts',
        'component accessibility states › moves focus to the first invalid field and announces validation status',
      ],
      [
        'accessibility/harness.contract.spec.ts',
        'audit harness detects deterministic known violations',
      ],
      [
        'accessibility/home.a11y.spec.ts',
        'overview accessibility › has no automatically detectable WCAG A/AA violations',
      ],
      [
        'accessibility/home.a11y.spec.ts',
        'overview accessibility › exposes semantic landmarks and accessible navigation names',
      ],
      [
        'accessibility/home.a11y.spec.ts',
        'overview accessibility › supports keyboard skip navigation',
      ],
      [
        'accessibility/policy.contract.spec.ts',
        'accessibility exclusion policy › accepts a reviewed future-dated exclusion',
      ],
      [
        'accessibility/policy.contract.spec.ts',
        'accessibility exclusion policy › fails closed when an exclusion expires',
      ],
      [
        'accessibility/policy.contract.spec.ts',
        'accessibility exclusion policy › rejects invalid calendar dates instead of normalizing them',
      ],
    ],
  ],
  [
    'smoke/navigation.spec.ts',
    [['smoke/navigation.spec.ts', 'primary navigation connects deterministic test surfaces']],
  ],
  [
    'visual/',
    [
      [
        'integration/combined-quality.spec.ts',
        'interactive preview state satisfies accessibility and visual contracts together',
      ],
      [
        'visual/components.visual.spec.ts',
        'component laboratory matches its default baseline',
      ],
      ['visual/components.visual.spec.ts', 'dialog open state matches its baseline'],
      ['visual/components.visual.spec.ts', 'validation error state matches its baseline'],
      ['visual/home.visual.spec.ts', 'overview page matches the governed visual baseline'],
      ['visual/home.visual.spec.ts', 'quality-signal card matches its component baseline'],
    ],
  ],
]);

function fail(message) {
  throw new Error(`Playwright evidence validation failed: ${message}`);
}

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attribute(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match?.[1] ? decodeXml(match[1]) : '';
}

const [junitPath, htmlPath, minimumRaw = '1', requiredToken = '', expectedHostsRaw = ''] =
  process.argv.slice(2);

if (!junitPath || !htmlPath) {
  fail(
    'usage: node scripts/validate-playwright-evidence.mjs <junit.xml> <report.html> [minimum-executed] [required-token] [expected-hosts]',
  );
}

const minimumExecuted = Number.parseInt(minimumRaw, 10);
if (!Number.isSafeInteger(minimumExecuted) || minimumExecuted < 1) {
  fail(`minimum-executed must be a positive integer; received ${minimumRaw}`);
}

let xml;
try {
  xml = readFileSync(junitPath, 'utf8');
} catch (error) {
  fail(`cannot read JUnit evidence at ${junitPath}: ${String(error)}`);
}

const root = xml.match(/<testsuites\b([^>]*)>/);
if (!root) {
  fail(`${junitPath} does not contain a <testsuites> root`);
}

const attributes = root[1] ?? '';
const readCount = (name) => {
  const match = attributes.match(new RegExp(`\\b${name}="(\\d+)"`));
  if (!match?.[1]) fail(`${junitPath} is missing numeric ${name} metadata`);
  return Number.parseInt(match[1], 10);
};

const tests = readCount('tests');
const failures = readCount('failures');
const errors = readCount('errors');
const skipped = readCount('skipped');
const executed = tests - skipped;

if (executed < minimumExecuted) {
  fail(
    `expected at least ${minimumExecuted} executed tests, found ${executed} (${tests} total, ${skipped} skipped)`,
  );
}
if (failures !== 0 || errors !== 0) {
  fail(`JUnit evidence reports ${failures} failures and ${errors} errors`);
}
if (requiredToken && !xml.includes(requiredToken)) {
  fail(`JUnit evidence does not contain required suite token ${requiredToken}`);
}

const expectedHosts = expectedHostsRaw
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
if (new Set(expectedHosts).size !== expectedHosts.length) {
  fail(`expected-hosts contains duplicates: ${expectedHostsRaw}`);
}

const testcases = [];
const testsuitePattern = /<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/gu;
for (const suiteMatch of xml.matchAll(testsuitePattern)) {
  const hostname = attribute(suiteMatch[1] ?? '', 'hostname');
  const suiteBody = suiteMatch[2] ?? '';
  const testcasePattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu;
  for (const testcaseMatch of suiteBody.matchAll(testcasePattern)) {
    testcases.push({
      classname: attribute(testcaseMatch[1] ?? '', 'classname'),
      name: attribute(testcaseMatch[1] ?? '', 'name'),
      hostname,
      body: testcaseMatch[2] ?? '',
    });
  }
}

if (requiredToken && !governedByToken.has(requiredToken)) {
  fail(`no governed evidence contract is registered for required token ${requiredToken}`);
}

const governed = governedByToken.get(requiredToken) ?? [];
for (const [expectedClassname, expectedName] of governed) {
  const matches = testcases.filter(
    (testcase) => testcase.classname === expectedClassname && testcase.name === expectedName,
  );
  const expectedCount = expectedHosts.length > 0 ? expectedHosts.length : 1;
  if (matches.length !== expectedCount) {
    fail(
      `governed test identity mismatch: expected ${expectedCount} ${expectedClassname} :: ${expectedName} execution(s); found ${matches.length}`,
    );
  }

  for (const hostname of expectedHosts) {
    const hostMatches = matches.filter((testcase) => testcase.hostname === hostname);
    if (hostMatches.length !== 1) {
      fail(
        `governed host attribution mismatch: expected exactly one ${hostname} execution for ${expectedClassname} :: ${expectedName}; found ${hostMatches.length}`,
      );
    }
  }

  if (matches.some((testcase) => /<(?:failure|error|skipped)\b/u.test(testcase.body))) {
    fail(`governed test did not pass: ${expectedClassname} :: ${expectedName}`);
  }
}

let htmlSize;
try {
  htmlSize = statSync(htmlPath).size;
} catch (error) {
  fail(`cannot stat HTML report at ${htmlPath}: ${String(error)}`);
}
if (htmlSize < 1_024) {
  fail(`HTML report at ${htmlPath} is unexpectedly small (${htmlSize} bytes)`);
}

console.log(
  `Validated Playwright evidence: ${executed} executed tests, ${skipped} skipped, ` +
    `governed=${governed.length}, hosts=${expectedHosts.join(',') || '<unbound>'}, ` +
    `JUnit=${junitPath}, HTML=${htmlPath} (${htmlSize} bytes)`,
);
