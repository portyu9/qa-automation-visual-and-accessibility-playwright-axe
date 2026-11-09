import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePlaywrightVersion } from './resolve-playwright-runtime.mjs';

function fixture(version = '1.2.3') {
  return {
    manifest: {
      devDependencies: {
        '@playwright/test': version,
        'playwright-core': version,
      },
    },
    lockfile: {
      packages: {
        '': {
          devDependencies: {
            '@playwright/test': version,
            'playwright-core': version,
          },
        },
        'node_modules/@playwright/test': {
          version,
          dependencies: { playwright: version },
        },
        'node_modules/playwright': {
          version,
          dependencies: { 'playwright-core': version },
        },
        'node_modules/playwright-core': { version },
      },
    },
  };
}

test('uses the exact release shared by manifest, lock root and transitive graph', () => {
  const { manifest, lockfile } = fixture();
  assert.equal(resolvePlaywrightVersion(manifest, lockfile), '1.2.3');
});

test('accepts a future compatible release without changing workflow pins', () => {
  const { manifest, lockfile } = fixture('2.3.4');
  assert.equal(resolvePlaywrightVersion(manifest, lockfile), '2.3.4');
});

test('rejects incompatible direct Playwright dependencies', () => {
  const { manifest, lockfile } = fixture();
  manifest.devDependencies['playwright-core'] = '1.2.4';
  assert.throws(
    () => resolvePlaywrightVersion(manifest, lockfile),
    /package.json playwright-core/u,
  );
});

test('rejects a mismatched installed browser revision', () => {
  const { manifest, lockfile } = fixture();
  lockfile.packages['node_modules/playwright-core'].version = '1.2.4';
  assert.throws(() => resolvePlaywrightVersion(manifest, lockfile), /locked playwright-core/u);
});

test('rejects root-lock and transitive dependency drift', () => {
  const { manifest, lockfile } = fixture();
  lockfile.packages[''].devDependencies['@playwright/test'] = '1.2.4';
  assert.throws(() => resolvePlaywrightVersion(manifest, lockfile), /lock root/u);
  lockfile.packages[''].devDependencies['@playwright/test'] = '1.2.3';
  lockfile.packages['node_modules/playwright'].dependencies['playwright-core'] = '1.2.4';
  assert.throws(() => resolvePlaywrightVersion(manifest, lockfile), /transitive/u);
});

test('rejects missing metadata, unbounded, prerelease or injection-shaped versions', () => {
  for (const version of ['^1.2.3', '1.2.3-beta.1', '1.2.3;echo bad', '', 'latest']) {
    const { manifest, lockfile } = fixture(version);
    assert.throws(() => resolvePlaywrightVersion(manifest, lockfile), /exact, stable/u);
  }
  assert.throws(() => resolvePlaywrightVersion({}, {}), /exact, stable/u);
});
