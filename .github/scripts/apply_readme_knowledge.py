from pathlib import Path
import re

path = Path('README.md')
text = path.read_text(encoding='utf-8')
marker = '## Dependency maintenance\n'
section = '''## Confidence boundaries

Visual regression and accessibility automation answer different questions. The framework keeps their oracles, evidence, and governance separate so a green pixel comparison is never treated as accessibility proof—and an automated accessibility scan is never treated as complete conformance.

| Signal | Confidence gained | Deliberate limit |
| --- | --- | --- |
| Canonical visual baseline | The governed expected pixels are tied to an accepted `main` state and can be traced to repository history | A baseline records expectation; it does not prove the UI is correct, usable, accessible, or intentionally designed |
| Exact-base pull-request comparison | A PR compares against the canonical artifact for its actual base revision rather than redefining expected pixels inside the same change | Pixel equality/difference is still an image oracle, not a semantic product oracle |
| Visual thresholds | Small rendering noise can be distinguished from material image differences under the configured policy | Thresholds trade sensitivity for noise tolerance; they can hide meaningful small changes or flag harmless rendering differences and therefore require review context |
| axe automated scan | The rendered page is evaluated against the configured automated accessibility-rule scope, with governed exclusions that require ownership, rationale, and expiry | Automated rules do not cover every accessibility requirement, usability need, cognitive concern, assistive-technology interaction, or human judgment |
| Keyboard/focus contracts | Selected focus order, operability, and visible-focus behaviors remain executable browser contracts | They do not constitute complete keyboard, screen-reader, switch-control, voice-control, zoom/reflow, or assistive-technology qualification |
| Cross-browser smoke | Critical visual/accessibility harness behavior survives explicitly qualified browser engines/projects | It does not imply pixel-identical rendering or complete accessibility equivalence across every engine/device/platform combination |
| Negative known-violation harness | The accessibility oracle is proven capable of detecting an intentionally introduced governed failure | Oracle sensitivity to one known failure does not prove sensitivity to all real accessibility defects |
| Retry + `failOnFlakyTests` | Retry diagnostics can be captured without allowing a recovered flaky test to become a clean CI result | Retries do not explain instability and should not be expanded to normalize nondeterministic screenshots or browser behavior |
| Screenshot/report/trace evidence | Failures retain attributable context and governed test identity | Images and traces can expose application-visible/session data; synthetic data and retention policy remain security requirements |
| CodeQL / npm Audit / Trivy / dependency review | Independent controls inspect source, advisory, repository/configuration/secret, and dependency-diff risk surfaces | Green scanners are scoped evidence, not proof of vulnerability absence |

A visual change should answer **“did pixels change from the governed expectation?”** Accessibility automation should answer **“did the configured machine-checkable rules and interaction contracts fail?”** Neither answer should be stretched into a broader claim it cannot support.

'''
if '## Confidence boundaries\n' not in text:
    if marker not in text:
        raise SystemExit('Dependency maintenance marker missing')
    text = text.replace(marker, section + marker)
path.write_text(text, encoding='utf-8')

patterns = [
    re.compile(r'\bPlaywright\s+v?\d', re.I),
    re.compile(r'\baxe(?:-core)?\s+v?\d', re.I),
    re.compile(r'\bNode(?:\.js)?\s+\d', re.I),
    re.compile(r'\bTypeScript\s+v?\d', re.I),
    re.compile(r'\bnpm\s+v?\d', re.I),
    re.compile(r'\bWCAG\s+\d+(?:\.\d+)*', re.I),
]
candidates = []
for md in [Path('README.md'), *Path('docs').rglob('*.md')]:
    for number, line in enumerate(md.read_text(encoding='utf-8').splitlines(), 1):
        if any(pattern.search(line) for pattern in patterns):
            candidates.append(f'{md}:{number}: {line}')
if candidates:
    raise SystemExit('Residual Visual/A11y version candidates:\n' + '\n'.join(candidates))
