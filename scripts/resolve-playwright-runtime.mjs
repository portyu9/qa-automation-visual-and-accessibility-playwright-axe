import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXACT_RELEASE = /^\d+\.\d+\.\d+$/u;

/**
 * Derive the browser-container release from the committed npm dependency graph.
 * Never allow a tag supplied independently of the exact package-lock contract.
 */
export function resolvePlaywrightVersion(manifest, lockfile) {
  const version = manifest?.devDependencies?.['@playwright/test'];
  if (typeof version !== 'string' || !EXACT_RELEASE.test(version)) {
    throw new Error('@playwright/test must use an exact, stable semantic version');
  }

  const versions = [
    ['package.json playwright-core', manifest?.devDependencies?.['playwright-core']],
    ['lock root @playwright/test', lockfile?.packages?.['']?.devDependencies?.['@playwright/test']],
    ['lock root playwright-core', lockfile?.packages?.['']?.devDependencies?.['playwright-core']],
    ['locked @playwright/test', lockfile?.packages?.['node_modules/@playwright/test']?.version],
    ['locked playwright', lockfile?.packages?.['node_modules/playwright']?.version],
    ['locked playwright-core', lockfile?.packages?.['node_modules/playwright-core']?.version],
    [
      'locked @playwright/test transitive playwright',
      lockfile?.packages?.['node_modules/@playwright/test']?.dependencies?.playwright,
    ],
    [
      'locked playwright transitive playwright-core',
      lockfile?.packages?.['node_modules/playwright']?.dependencies?.['playwright-core'],
    ],
  ];

  for (const [source, actual] of versions) {
    if (actual !== version) {
      throw new Error(`Playwright version mismatch: ${source}=${String(actual)}; expected ${version}`);
    }
  }

  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  console.log(resolvePlaywrightVersion(manifest, lockfile));
}
