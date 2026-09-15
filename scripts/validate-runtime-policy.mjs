import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const packageLock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const nvmrc = (await readFile('.nvmrc', 'utf8')).trim();
const workflows = Object.fromEntries(
  await Promise.all(
    ['ci.yml', 'security.yml', 'visual-baseline.yml'].map(async (name) => [
      name,
      await readFile(`.github/workflows/${name}`, 'utf8'),
    ]),
  ),
);

const failures = [];
const fail = (message) => failures.push(message);

const expectedNodeEngine = '>=24.0.0 <25';
const exactVersion = /^(\d+)\.(\d+)\.(\d+)$/u;
const packageManager = String(packageJson.packageManager ?? '');
const npmMatch = /^npm@(\d+\.\d+\.\d+)$/u.exec(packageManager);
const nodeMatch = exactVersion.exec(nvmrc);
const nodeTypes = String(packageJson.devDependencies?.['@types/node'] ?? '');
const nodeTypesMatch = exactVersion.exec(nodeTypes);
const rootLock = packageLock.packages?.[''] ?? {};
const lockedNodeTypes = packageLock.packages?.['node_modules/@types/node']?.version;

if (packageJson.engines?.node !== expectedNodeEngine) {
  fail(`package.json engines.node must be ${expectedNodeEngine}`);
}
if (rootLock.engines?.node !== packageJson.engines?.node) {
  fail('package-lock.json root Node engine must match package.json exactly');
}
if (!nodeMatch || Number(nodeMatch[1]) !== 24) {
  fail('.nvmrc must pin an exact Node 24 patch release');
}
if (!npmMatch) {
  fail('package.json packageManager must pin npm as npm@x.y.z');
}
if (!nodeTypesMatch || Number(nodeTypesMatch[1]) !== 24) {
  fail('package.json @types/node must pin an exact Node 24 declaration release');
}
if (rootLock.devDependencies?.['@types/node'] !== nodeTypes) {
  fail('package-lock.json root @types/node declaration must match package.json exactly');
}
if (lockedNodeTypes !== nodeTypes) {
  fail(
    `package-lock.json installed @types/node must equal the committed declaration pin ${nodeTypes}`,
  );
}

const npmVersion = npmMatch?.[1];
for (const [name, workflow] of Object.entries(workflows)) {
  if (!nodeMatch || !workflow.includes(`NODE_VERSION: ${nvmrc}`)) {
    fail(`${name} must bind NODE_VERSION to .nvmrc (${nvmrc})`);
  }
  if (!npmVersion || !workflow.includes(`NPM_VERSION: ${npmVersion}`)) {
    fail(`${name} must bind NPM_VERSION to packageManager (${npmVersion ?? 'invalid'})`);
  }

  const setupNodeCount = [...workflow.matchAll(/uses: actions\/setup-node@/gu)].length;
  const governedNodeCount = [...workflow.matchAll(/node-version: \$\{\{ env\.NODE_VERSION \}\}/gu)]
    .length;
  if (setupNodeCount !== governedNodeCount) {
    fail(
      `${name} must route every actions/setup-node invocation through env.NODE_VERSION; ` +
        `setup-node=${setupNodeCount}, governed=${governedNodeCount}`,
    );
  }
}

const ci = workflows['ci.yml'];
if (ci.includes('NODE_TYPES_VERSION:')) {
  fail('ci.yml must not duplicate the exact @types/node patch version in workflow configuration');
}
if (
  ci.includes(
    'npm install --no-save --ignore-scripts --package-lock=false "@types/node@${NODE_TYPES_VERSION}"',
  )
) {
  fail('ci.yml must not replace the committed Node declaration graph after npm ci');
}

const requiredNodeTypeChecks = [
  "require('./package.json').devDependencies['@types/node']",
  "require('./node_modules/@types/node/package.json').version",
  'node_major="${NODE_VERSION%%.*}"',
  'types_major="${installed%%.*}"',
  '[[ "$installed" == "$declared" ]]',
  '[[ "$types_major" == "$node_major" ]]',
];
for (const snippet of requiredNodeTypeChecks) {
  if (!ci.includes(snippet)) {
    fail(`ci.yml must preserve the dynamic Node declaration compatibility check: ${snippet}`);
  }
}

const scripts = packageJson.scripts ?? {};
if (scripts['runtime-policy:check'] !== 'node scripts/validate-runtime-policy.mjs') {
  fail('package.json must expose runtime-policy:check');
}
if (!String(scripts.check ?? '').includes('npm run runtime-policy:check')) {
  fail('package.json check must execute runtime-policy:check');
}

if (failures.length) {
  console.error('Runtime policy contract failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Runtime policy contract passed: node=${nvmrc}, engine=${expectedNodeEngine}, npm=${npmVersion}, node-types=${nodeTypes}, workflows=${Object.keys(workflows).join(',')}`,
);
