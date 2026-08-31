import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import {
  WCAG_AA_TAGS,
  type AccessibilityAuditOptions,
  type AccessibilityExclusion,
  validateExclusions,
} from './policy.js';

type AxeResults = Awaited<ReturnType<InstanceType<typeof AxeBuilder>['analyze']>>;
type AxeViolation = AxeResults['violations'][number];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function formatTargets(nodes: AxeViolation['nodes']): string {
  return nodes
    .flatMap((node) => node.target)
    .map((target) => `\`${String(target)}\``)
    .join(', ');
}

function formatViolation(violation: AxeViolation): string {
  const impact = violation.impact ?? 'unknown';
  const targets = formatTargets(violation.nodes);
  return `- **${violation.id}** (${impact}): ${violation.help}\n  - ${violation.helpUrl}\n  - Targets: ${targets}`;
}

function buildMarkdownReport(
  results: AxeResults,
  exclusions: readonly AccessibilityExclusion[],
): string {
  const violationSection =
    results.violations.length === 0
      ? '- None'
      : results.violations.map((violation) => formatViolation(violation)).join('\n');

  const exclusionSection =
    exclusions.length === 0
      ? '- None'
      : exclusions
          .map(
            (item) =>
              `- \`${item.selector}\` — ${item.reason} (issue: ${item.issue}; expires: ${item.expires})`,
          )
          .join('\n');

  return [
    '# Accessibility scan',
    '',
    `- URL: ${results.url}`,
    `- Violations: ${results.violations.length}`,
    `- Incomplete checks requiring review: ${results.incomplete.length}`,
    `- Passes: ${results.passes.length}`,
    '',
    '## Violations',
    '',
    violationSection,
    '',
    '## Explicit exclusions',
    '',
    exclusionSection,
    '',
    '> Automated accessibility testing does not establish WCAG conformance. Review incomplete checks and execute the manual checklist for release-critical surfaces.',
  ].join('\n');
}

export class AccessibilityAuditor {
  public constructor(
    private readonly page: Page,
    private readonly testInfo: TestInfo,
  ) {}

  public async scan(options: AccessibilityAuditOptions = {}): Promise<AxeResults> {
    const exclusions = options.exclusions ?? [];
    validateExclusions(exclusions);

    let builder = new AxeBuilder({ page: this.page }).options({
      runOnly: { type: 'tag', values: [...WCAG_AA_TAGS] },
      rules: { 'target-size': { enabled: true } },
    });

    for (const selector of options.include ?? []) {
      builder = builder.include(selector);
    }

    for (const exclusion of exclusions) {
      builder = builder.exclude(exclusion.selector);
    }

    const results = await builder.analyze();
    const name = slugify(options.name ?? this.testInfo.title) || 'accessibility';

    await Promise.all([
      this.testInfo.attach(`${name}-axe.json`, {
        body: Buffer.from(JSON.stringify(results, null, 2)),
        contentType: 'application/json',
      }),
      this.testInfo.attach(`${name}-axe.md`, {
        body: Buffer.from(buildMarkdownReport(results, exclusions)),
        contentType: 'text/markdown',
      }),
    ]);

    return results;
  }

  public assertNoViolations(results: AxeResults): void {
    if (results.violations.length === 0) {
      return;
    }

    const summary = results.violations.map((violation) => formatViolation(violation)).join('\n');
    throw new Error(`Automated accessibility gate failed:\n${summary}`);
  }
}
