export const WCAG_AA_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
] as const;

export interface AccessibilityExclusion {
  selector: string;
  reason: string;
  issue: string;
  expires: string;
}

export interface AccessibilityAuditOptions {
  name?: string;
  include?: readonly string[];
  exclusions?: readonly AccessibilityExclusion[];
}

function parseExpiry(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return null;
  }

  return date;
}

export function validateExclusions(
  exclusions: readonly AccessibilityExclusion[],
  now: Date = new Date(),
): void {
  for (const exclusion of exclusions) {
    if (exclusion.selector.trim() === '') {
      throw new Error('Accessibility exclusions require a non-empty selector.');
    }
    if (exclusion.reason.trim().length < 12) {
      throw new Error(`Accessibility exclusion ${exclusion.selector} needs a meaningful reason.`);
    }
    if (exclusion.issue.trim() === '') {
      throw new Error(`Accessibility exclusion ${exclusion.selector} requires an issue reference.`);
    }

    const expiry = parseExpiry(exclusion.expires);
    if (expiry === null) {
      throw new Error(
        `Accessibility exclusion ${exclusion.selector} must use a valid ISO expiry date (YYYY-MM-DD).`,
      );
    }
    if (expiry.getTime() < now.getTime()) {
      throw new Error(
        `Accessibility exclusion ${exclusion.selector} expired on ${exclusion.expires}; remediate or explicitly re-review it.`,
      );
    }
  }
}
