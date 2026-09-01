import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

const root = process.cwd();
const failures = [];
const ignoredDirectories = new Set(['.git', 'node_modules', 'playwright-report', 'test-results']);

function fail(message) {
  failures.push(message);
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : walk(path);
    }
    return extname(entry.name) === '.md' ? [path] : [];
  });
}

for (const markdownPath of walk(root)) {
  const markdown = readFileSync(markdownPath, 'utf8');
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(linkPattern)) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget || rawTarget.startsWith('#') || /^(?:https?:|mailto:)/i.test(rawTarget)) {
      continue;
    }

    const targetWithoutTitle = rawTarget.split(/\s+["']/u, 1)[0] ?? rawTarget;
    const pathPart = targetWithoutTitle.split('#', 1)[0] ?? '';
    if (!pathPart) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      fail(`${markdownPath}: invalid URL encoding in local link ${rawTarget}`);
      continue;
    }

    const resolved = resolve(dirname(markdownPath), decoded);
    if (!existsSync(resolved)) {
      fail(`${markdownPath}: local link does not resolve: ${rawTarget}`);
    }
  }
}

const readmePath = join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const repositoryMap = readme.match(/## Repository map\s+```text\n([\s\S]*?)```/u)?.[1];
if (!repositoryMap) {
  fail('README.md: repository map text block is missing');
} else {
  for (const line of repositoryMap.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '.') continue;
    const entry = trimmed.replace(/^[│├└─\s]+/u, '');
    if (!entry.endsWith('/')) {
      fail(`README.md: repository map must contain directories only; found ${entry}`);
    }
  }
}

const requiredWorkflowBadges = [
  ['CI', 'ci.yml'],
  ['Security', 'security.yml'],
  ['Visual Baseline', 'visual-baseline.yml'],
];
for (const [label, workflow] of requiredWorkflowBadges) {
  const badgeFragment = `actions/workflows/${workflow}/badge.svg`;
  if (!readme.includes(badgeFragment)) {
    fail(`README.md: ${label} workflow badge is missing (${workflow})`);
  }
}

const mermaidBlocks = [...readme.matchAll(/```mermaid\s*\n([\s\S]*?)```/gu)];
if (mermaidBlocks.length === 0) {
  fail('README.md: Mermaid architecture diagram is missing');
} else if (!mermaidBlocks.some((match) => /^flowchart\s+/mu.test(match[1] ?? ''))) {
  fail('README.md: Mermaid documentation must include a flowchart architecture diagram');
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const nodeVersion = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
const npmVersion = String(packageJson.packageManager ?? '').replace(/^npm@/u, '');
if (!readme.includes(`Node.js **${nodeVersion} LTS**`)) {
  fail(`README.md: qualified Node version must match .nvmrc (${nodeVersion})`);
}
if (!npmVersion || !readme.includes(`npm **${npmVersion}**`)) {
  fail(
    `README.md: qualified npm version must match packageManager (${packageJson.packageManager})`,
  );
}

const ciWorkflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const securityWorkflow = readFileSync(join(root, '.github/workflows/security.yml'), 'utf8');
const visualBaselineWorkflow = readFileSync(
  join(root, '.github/workflows/visual-baseline.yml'),
  'utf8',
);
const playwrightEvidencePolicy = readFileSync(
  join(root, 'scripts/validate-playwright-evidence.mjs'),
  'utf8',
);
if (!ciWorkflow.includes('name: quality-gate')) {
  fail('.github/workflows/ci.yml: stable quality-gate job name is missing');
}
if (!securityWorkflow.includes('name: security-gate')) {
  fail('.github/workflows/security.yml: stable security-gate job name is missing');
}
if (!securityWorkflow.includes('supply-chain-policy:')) {
  fail('.github/workflows/security.yml: security supply-chain policy job is missing');
}
if (!securityWorkflow.includes('TRIVY_INCLUDE_DEV_DEPS')) {
  fail('.github/workflows/security.yml: Trivy must explicitly include development dependencies');
}
if (!securityWorkflow.includes('validate-security-evidence.mjs')) {
  fail('.github/workflows/security.yml: attributed security evidence validator is not executed');
}
if (!ciWorkflow.includes('validate-playwright-evidence.mjs')) {
  fail('.github/workflows/ci.yml: semantic Playwright evidence validator is not executed');
}
const requiredCiEvidenceContracts = [
  '6 framework/config.contract.spec.ts chromium',
  '11 accessibility/ chromium',
  '1 smoke/navigation.spec.ts "${{ matrix.browser }}"',
  '12 visual/ chromium,mobile-chromium',
];
for (const contract of requiredCiEvidenceContracts) {
  if (!ciWorkflow.includes(contract)) {
    fail(`.github/workflows/ci.yml: governed Playwright evidence contract is missing: ${contract}`);
  }
}
if (!visualBaselineWorkflow.includes('12 visual/ chromium,mobile-chromium')) {
  fail(
    '.github/workflows/visual-baseline.yml: canonical baseline evidence must bind visual identities to chromium and mobile-chromium',
  );
}
if (!playwrightEvidencePolicy.includes("'visual/'")) {
  fail('scripts/validate-playwright-evidence.mjs: visual evidence policy is not registered');
}
if (!playwrightEvidencePolicy.includes('no governed evidence contract is registered')) {
  fail('scripts/validate-playwright-evidence.mjs: unknown governed tokens must fail closed');
}
for (const source of [
  'scripts/validate-security-evidence.mjs',
  'scripts/validate-playwright-evidence.mjs',
]) {
  if (!existsSync(join(root, source)))
    fail(`${source}: required evidence policy source is missing`);
}
if (!readme.includes('`CI / quality-gate`') || !readme.includes('`Security / security-gate`')) {
  fail('README.md: merge-enforcement guidance must name both stable gate statuses');
}

if (failures.length > 0) {
  console.error('Documentation contract failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  'Documentation contract passed: local links, workflow badges, Mermaid architecture, toolchain claims, evidence policy, gate names, and directory-only repository map are consistent.',
);
