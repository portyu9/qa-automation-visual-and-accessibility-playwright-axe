import { readFileSync, statSync } from 'node:fs';

function fail(message) {
  throw new Error(`Playwright evidence validation failed: ${message}`);
}

const [junitPath, htmlPath, minimumRaw = '1', requiredToken = ''] = process.argv.slice(2);

if (!junitPath || !htmlPath) {
  fail('usage: node scripts/validate-playwright-evidence.mjs <junit.xml> <report.html> [minimum-executed] [required-token]');
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
  fail(`expected at least ${minimumExecuted} executed tests, found ${executed} (${tests} total, ${skipped} skipped)`);
}
if (failures !== 0 || errors !== 0) {
  fail(`JUnit evidence reports ${failures} failures and ${errors} errors`);
}
if (requiredToken && !xml.includes(requiredToken)) {
  fail(`JUnit evidence does not contain required suite token ${requiredToken}`);
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
  `Validated Playwright evidence: ${executed} executed tests, ${skipped} skipped, JUnit=${junitPath}, HTML=${htmlPath}`,
);
