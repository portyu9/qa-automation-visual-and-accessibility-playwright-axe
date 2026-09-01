import { existsSync, readFileSync, statSync } from 'node:fs';

const expectedTrivyVersion = '0.74.0';
const governedPackages = [
  '@axe-core/playwright',
  '@playwright/test',
  '@eslint/js',
  '@types/node',
  'eslint',
  'prettier',
  'typescript',
  'typescript-eslint',
];

function fail(message) {
  throw new Error(`Security evidence validation failed: ${message}`);
}

function readJson(path) {
  if (!existsSync(path) || statSync(path).size === 0) {
    fail(`missing or empty JSON evidence: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

const lock = readJson('package-lock.json');
if (!lock.packages || typeof lock.packages !== 'object') {
  fail('package-lock.json does not contain a packages inventory');
}

function lockedVersion(name) {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry || typeof entry.version !== 'string' || entry.version.length === 0) {
    fail(`package-lock.json does not contain governed package ${name}`);
  }
  return entry.version;
}

function validateNpmAudit(path) {
  const report = readJson(path);
  const dependencies = report.metadata?.dependencies;
  const vulnerabilities = report.metadata?.vulnerabilities;
  if (!dependencies || !vulnerabilities) {
    fail('npm audit evidence lacks dependency or vulnerability metadata');
  }

  if (!Number.isInteger(dependencies.total) || dependencies.total < 90) {
    fail(`npm audit dependency graph is unexpectedly shallow: total=${dependencies.total}`);
  }
  if (!Number.isInteger(dependencies.dev) || dependencies.dev < 90) {
    fail(`npm audit development graph is unexpectedly shallow: dev=${dependencies.dev}`);
  }

  const high = Number(vulnerabilities.high ?? 0);
  const critical = Number(vulnerabilities.critical ?? 0);
  if (high !== 0 || critical !== 0) {
    fail(`npm audit contains gated advisories: HIGH=${high} CRITICAL=${critical}`);
  }

  console.log(
    `Validated npm audit evidence: total=${dependencies.total}, dev=${dependencies.dev}, HIGH=0, CRITICAL=0`,
  );
}

function validateTrivy(path) {
  const report = readJson(path);
  if (report.Trivy?.Version !== expectedTrivyVersion) {
    fail(`unexpected Trivy version: ${report.Trivy?.Version ?? '<missing>'}`);
  }
  if (!Array.isArray(report.Results) || report.Results.length === 0) {
    fail('Trivy evidence contains no Results');
  }

  const npmResults = report.Results.filter(
    (result) => result?.Type === 'npm' || String(result?.Target ?? '').includes('package-lock.json'),
  );
  if (npmResults.length === 0) {
    fail('Trivy evidence contains no attributed npm/package-lock result');
  }

  const packages = npmResults.flatMap((result) => (Array.isArray(result.Packages) ? result.Packages : []));
  const lockPackageCount = Object.keys(lock.packages).filter((key) => key.startsWith('node_modules/')).length;
  const minimumInventory = Math.max(60, Math.floor(lockPackageCount * 0.7));
  if (packages.length < minimumInventory) {
    fail(
      `Trivy npm inventory is unexpectedly shallow: packages=${packages.length}, ` +
        `minimum=${minimumInventory}, lockPackages=${lockPackageCount}`,
    );
  }

  for (const name of governedPackages) {
    const version = lockedVersion(name);
    if (!packages.some((pkg) => pkg?.Name === name && pkg?.Version === version)) {
      fail(`Trivy npm evidence does not contain governed package ${name}@${version}`);
    }
  }

  const vulnerabilities = npmResults
    .flatMap((result) => result.Vulnerabilities ?? [])
    .filter((item) => item?.Severity === 'HIGH' || item?.Severity === 'CRITICAL');
  const misconfigurations = report.Results.flatMap((result) => result?.Misconfigurations ?? []);
  const secrets = report.Results.flatMap((result) => result?.Secrets ?? []);

  if (vulnerabilities.length !== 0) {
    fail(`Trivy npm evidence contains ${vulnerabilities.length} HIGH/CRITICAL finding(s)`);
  }
  if (misconfigurations.length !== 0) {
    fail(`Trivy evidence contains ${misconfigurations.length} gated misconfiguration finding(s)`);
  }
  if (secrets.length !== 0) {
    fail(`Trivy evidence contains ${secrets.length} gated secret finding(s)`);
  }

  console.log(
    `Validated Trivy evidence: npmPackages=${packages.length}/${lockPackageCount}, ` +
      `governedPackages=${governedPackages.length}, HIGH/CRITICAL=0, ` +
      `misconfigurations=0, secrets=0, scanner=${expectedTrivyVersion}`,
  );
}

const [mode, path] = process.argv.slice(2);
if (!mode || !path) {
  fail('usage: node scripts/validate-security-evidence.mjs <npm-audit|trivy> <json-path>');
}

if (mode === 'npm-audit') {
  validateNpmAudit(path);
} else if (mode === 'trivy') {
  validateTrivy(path);
} else {
  fail(`unknown validation mode: ${mode}`);
}
