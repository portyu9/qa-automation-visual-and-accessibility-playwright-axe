import { readFileSync, statSync } from 'node:fs';

const governedByToken = new Map([
  [
    'framework/config.contract.spec.ts',
    [
      ['framework/config.contract.spec.ts', 'runtime configuration contract › accepts valid ports and rejects partial or out-of-range values'],
      ['framework/config.contract.spec.ts', 'runtime configuration contract › defaults to the deterministic loopback target'],
      ['framework/config.contract.spec.ts', 'runtime configuration contract › accepts absolute http and https targets without hidden URL state'],
      ['framework/config.contract.spec.ts', 'runtime configuration contract › rejects unsupported schemes, embedded credentials, query strings, and fragments'],
      ['framework/server.contract.spec.ts', 'deterministic fixture server contract › rejects partially numeric ports instead of silently truncating them'],
      ['framework/server.contract.spec.ts', 'deterministic fixture server contract › serves only contained fixture files with defensive response headers'],
    ],
  ],
  [
    'accessibility/',
    [
      ['accessibility/components.a11y.spec.ts', 'component accessibility states › passes automated checks in the default state'],
      ['accessibility/components.a11y.spec.ts', 'component accessibility states › keeps tabs operable with arrow keys and synchronized state'],
      ['accessibility/components.a11y.spec.ts', 'component accessibility states › passes automated checks while the modal dialog is open'],
      ['accessibility/components.a11y.spec.ts', 'component accessibility states › moves focus to the first invalid field and announces validation status'],
      ['accessibility/harness.contract.spec.ts', 'audit harness detects deterministic known violations'],
      ['accessibility/home.a11y.spec.ts', 'overview accessibility › has no automatically detectable WCAG A/AA violations'],
      ['accessibility/home.a11y.spec.ts', 'overview accessibility › exposes semantic landmarks and accessible navigation names'],
      ['accessibility/home.a11y.spec.ts', 'overview accessibility › supports keyboard skip navigation'],
      ['accessibility/policy.contract.spec.ts', 'accessibility exclusion policy › accepts a reviewed future-dated exclusion'],
      ['accessibility/policy.contract.spec.ts', 'accessibility exclusion policy › fails closed when an exclusion expires'],
      ['accessibility/policy.contract.spec.ts', 'accessibility exclusion policy › rejects invalid calendar dates instead of normalizing them'],
    ],
  ],
  [
    'smoke/navigation.spec.ts',
    [
      ['smoke/navigation.spec.ts', 'primary navigation connects deterministic test surfaces'],
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

const [junitPath, htmlPath, minimumRaw = '1', requiredToken = ''] = process.argv.slice(2);

if (!junitPath || !htmlPath) {
  fail(
    'usage: node scripts/validate-playwright-evidence.mjs <junit.xml> <report.html> [minimum-executed] [required-token]',
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

const testcases = [];
const testcasePattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu;
for (const match of xml.matchAll(testcasePattern)) {
  testcases.push({
    classname: attribute(match[1] ?? '', 'classname'),
    name: attribute(match[1] ?? '', 'name'),
    body: match[2] ?? '',
  });
}

const governed = governedByToken.get(requiredToken) ?? [];
for (const [expectedClassname, expectedName] of governed) {
  const matches = testcases.filter(
    (testcase) => testcase.classname === expectedClassname && testcase.name === expectedName,
  );
  if (matches.length !== 1) {
    fail(
      `governed test identity mismatch: expected exactly one ${expectedClassname} :: ${expectedName}; found ${matches.length}`,
    );
  }
  if (/<(?:failure|error|skipped)\b/u.test(matches[0].body)) {
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
    `governed=${governed.length}, JUnit=${junitPath}, HTML=${htmlPath} (${htmlSize} bytes)`,
);
