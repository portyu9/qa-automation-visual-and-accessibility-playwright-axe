from pathlib import Path
import re

root = Path('.')
files = [root / 'README.md', *sorted((root / 'docs').rglob('*.md'))]
techs = [
    'Node.js', 'Node', 'npm', 'Playwright', 'axe-core', 'TypeScript', 'WCAG',
    'Chromium', 'Chrome', 'Firefox', 'WebKit', 'ESLint', 'Prettier', 'Trivy', 'CodeQL'
]
exact = {
    'Node.js **24.20.0 LTS**': 'Node.js',
    'npm **11.19.1**': 'npm',
    'Node 24.20.0': 'primary Node runtime',
    'Node 24': 'primary Node runtime',
    'npm@11.19.1': 'npm',
    'npm 11.19.1': 'npm',
    'WCAG 2.0/2.1/2.2 A/AA': 'WCAG A/AA',
    'WCAG 2.0/2.1/2.2': 'WCAG',
    'WCAG 2.2': 'WCAG',
    'WCAG 2.1': 'WCAG',
    'WCAG 2.0': 'WCAG',
}
badge_rules = [
    (r'/badge/Playwright-[0-9][^-?)]*-(2EAD33(?:\?[^)]*)?)', r'/badge/Playwright-browser-\1'),
    (r'/badge/axe--core-[0-9][^-?)]*-(005A9C(?:\?[^)]*)?)', r'/badge/axe--core-accessibility-\1'),
    (r'/badge/TypeScript-[0-9][^-?)]*-(3178C6(?:\?[^)]*)?)', r'/badge/TypeScript-language-\1'),
    (r'/badge/Node\.js-[0-9][^-?)]*-(339933(?:\?[^)]*)?)', r'/badge/Node.js-runtime-\1'),
    (r'/badge/WCAG-[0-9A-Za-z%._-]*-(7C3AED(?:\?[^)]*)?)', r'/badge/WCAG-A%2FAA-\1'),
]

for path in files:
    text = path.read_text(encoding='utf-8')
    for old, new in exact.items():
        text = text.replace(old, new)
    for pattern, replacement in badge_rules:
        text = re.sub(pattern, replacement, text)
    for tech in techs:
        text = re.sub(
            rf'(?i)\b{re.escape(tech)}\s+(?:\*\*|`)?v?\d+(?:\.\d+)*(?:\.x)?(?:\s+LTS)?(?:\*\*|`)?',
            tech,
            text,
        )
    text = re.sub(r'(?i)\bnpm@\d+(?:\.\d+)*', 'npm', text)
    path.write_text(text, encoding='utf-8')

validator = root / 'scripts' / 'validate-docs.mjs'
text = validator.read_text(encoding='utf-8')
old = """const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
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
"""
new = """const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const nodeVersion = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
if (!nodeVersion || !String(packageJson.packageManager ?? '').startsWith('npm@')) {
  fail('repository toolchain pins must remain machine-readable in .nvmrc and package.json');
}
if (!readme.includes('Node.js') || !readme.includes('npm')) {
  fail('README.md: versionless Node.js and npm toolchain documentation is required');
}
"""
if old not in text:
    raise SystemExit('expected Visual numeric toolchain validator block not found')
text = text.replace(old, new).replace('toolchain claims, ', 'versionless toolchain claims, ')
validator.write_text(text, encoding='utf-8')

names = r'(?:Node\.js|Node|npm|Playwright|axe-core|TypeScript|WCAG|Chromium|Chrome|Firefox|WebKit|ESLint|Prettier|Trivy|CodeQL)'
patterns = [
    re.compile(rf'(?i)\b{names}\s+(?:\*\*|`)?v?\d+(?:\.\d+)*(?:\.x)?'),
    re.compile(r'(?i)\bnpm@\d'),
    re.compile(r'(?i)/badge/(?:Playwright|axe--core|TypeScript|Node\.js)-\d'),
    re.compile(r'(?i)WCAG[^\n|]{0,12}\d+\.\d+'),
]
leftovers = []
for path in files:
    for line_no, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        if any(pattern.search(line) for pattern in patterns):
            leftovers.append(f'{path}:{line_no}: {line}')
if leftovers:
    print('\n'.join(leftovers))
    raise SystemExit(1)
