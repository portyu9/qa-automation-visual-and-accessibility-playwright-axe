# Security policy

## Supported versions

Security fixes are applied to the current `main` branch. This repository is a test framework rather than a versioned runtime service; older snapshots or forks are not maintained as supported release lines.

## Reporting a vulnerability

Do not publish exploit details, credentials, tokens, or sensitive target-system information in a public issue.

Use GitHub's private vulnerability reporting / security advisory flow for this repository when that option is available. If private reporting is not exposed in the repository UI, contact the repository owner through their GitHub profile with only enough non-sensitive information to establish a private channel; do not attach exploit material to a public issue.

Include, when safe to share privately:

- affected commit/version and component;
- reproducible impact and prerequisites;
- proof-of-concept details with secrets removed;
- suggested mitigation, if known.

## Scope

Relevant reports include vulnerabilities in test infrastructure, unsafe workflow permissions, artifact or cache poisoning paths, credential exposure, dependency/supply-chain compromise, unsafe target URL handling, and code paths that could execute untrusted input in CI.

Automated controls include Dependabot, change-aware Dependency Review when GitHub Dependency graph is available, HIGH/CRITICAL npm advisory gating, Trivy dependency/configuration/secret scanning, and CodeQL `security-extended` analysis. These controls have different scopes, do not substitute for one another, and supplement rather than replace responsible disclosure and human review.
