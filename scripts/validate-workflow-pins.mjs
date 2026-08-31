import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const workflowsRoot = join(process.cwd(), '.github');
const failures = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return ['.yml', '.yaml'].includes(extname(entry.name)) ? [path] : [];
  });
}

for (const path of walk(workflowsRoot)) {
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const reference = line.match(/^\s*uses:\s*([^\s#]+)/u)?.[1];
    if (!reference || reference.startsWith('./')) return;

    if (reference.startsWith('docker://')) {
      if (!/@sha256:[0-9a-f]{64}$/iu.test(reference)) {
        failures.push(`${path}:${index + 1}: Docker action must use an immutable sha256 digest: ${reference}`);
      }
      return;
    }

    const separator = reference.lastIndexOf('@');
    const ref = separator >= 0 ? reference.slice(separator + 1) : '';
    if (!/^[0-9a-f]{40}$/iu.test(ref)) {
      failures.push(`${path}:${index + 1}: external action must use a full 40-character commit SHA: ${reference}`);
    }
  });
}

if (failures.length > 0) {
  console.error('Workflow pin contract failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Workflow pin contract passed: all external actions use immutable commit SHAs or Docker digests.');
