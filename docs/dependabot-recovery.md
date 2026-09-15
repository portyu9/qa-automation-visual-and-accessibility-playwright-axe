# Dependabot Recovery Contract

## Purpose

Dependency recovery handles a narrow operational problem: a routine, already-governable Dependabot pull request can fail qualification because hosted infrastructure or an external package service had a transient outage. Recovery must remove that operational noise without converting real test, security, compatibility, visual, accessibility, provenance, or policy failures into green checks.

The dependency-governance workflow remains the only autonomous merge authority. Recovery can request one bounded workflow rerun; it can never approve or merge a pull request.

## Trust boundary

Recovery executes only from trusted code on the default branch. It reuses the dependency-governance identity proof before considering any action: canonical Dependabot account identity, one GitHub-verified signed Dependabot commit, canonical author/committer identities, signed update metadata, one parent equal to the current `main` head, and an allowlisted dependency ecosystem.

The controller never checks out or executes privileged recovery logic from the Dependabot branch. It never pushes to a Dependabot branch, calls GitHub's update-branch endpoint, synthesizes commits, rewrites lockfiles, edits source, or comments `@dependabot recreate` from automation. Stale PRs use Dependabot's native `rebase-strategy: auto` and remain ineligible until a fresh signed Dependabot commit is directly based on current `main`.

Control-plane changes are outside recovery. `.github/dependabot.yml`, governance/recovery policy, governance/recovery scripts, and privileged workflows remain manual-review paths.

## Retry decision

A required CI or Security workflow may be rerun only when every condition below is true:

1. the exact-head workflow run completed with conclusion `failure`;
2. its `run_attempt` is below the configured cap of two, allowing at most one automatic rerun;
3. at least one non-aggregate leaf job failed;
4. every failed leaf job has exactly one failed step;
5. every failed step is an explicitly allowlisted infrastructure operation such as dependency installation, runtime/browser setup, or evidence upload;
6. the failed job log contains a narrow transient infrastructure signature such as `EAI_AGAIN`, `ECONNRESET`, `ETIMEDOUT`, a contextual HTTP 502/503/504 response, or an equivalent explicitly modeled transport failure;
7. no failed leaf job is deterministic, functional, ambiguous, or outside the allowlist.

The controller reruns only failed jobs in that existing exact-head workflow run. It does not create a substitute qualification run with different inputs or a different commit.

## Fail-closed cases

Automatic recovery is forbidden for static-quality failures, framework-contract failures, smoke tests, accessibility tests, visual comparisons, aggregate-gate failures without a failed leaf job, audit/scanner findings, multiple failed steps in one job, mixed transient and deterministic failures, missing logs, unrecognized errors, cancelled/timed-out/action-required/stale workflow conclusions, a second failed run attempt, noncanonical provenance, stale base ancestry, major/downgrade/prerelease/unknown updates, or control-plane changes.

A network-looking string inside a functional-test failure does not make the failure transient: step identity is checked before log signatures. Generic phrases such as `Service Unavailable` without a precise modeled transport/status signature are intentionally insufficient.

## State machine

A routine dependency update therefore moves through this bounded path:

`Dependabot proposal -> provenance/semantic eligibility -> exact-head CI/Security -> optional one-time proven-transient rerun -> exact-head CI/Security success -> dependency governance merge`

A stale proposal instead follows:

`stale Dependabot head -> native Dependabot auto-rebase -> new signed single commit -> normal qualification`

Any deterministic or ambiguous failure follows:

`failure -> hard stop -> evidence remains red for investigation`

There is no automatic branch mutation or source-code repair path.

## False-positive controls

The recovery self-check suite deliberately tests both positive and adversarial cases. It proves that known transient signatures can authorize a retry only in allowlisted infrastructure steps, while the same strings are rejected inside functional steps. It also covers mixed failures, multiple failed steps, aggregate-only failures, attempt exhaustion, unsupported workflow conclusions, unknown file scope, control-plane paths, and noncanonical provenance.

Configuration contains a kill switch (`enabled`) and the attempt cap. Expansion of transient steps or signatures is a privileged policy change and must pass the same manual control-plane review as dependency governance itself.

## Operational interpretation

A recovery rerun is not evidence that the dependency is safe; it only acknowledges that the first qualification attempt was provably inconclusive because of a modeled infrastructure incident. The rerun must still produce the repository's ordinary stable CI and Security gates on the exact Dependabot head. Governance then independently re-evaluates provenance, semantic scope, base freshness, and exact-head qualification before any merge.

If the second attempt fails, if the failure class is not modeled, or if evidence is incomplete, automation stops. Operators investigate the original evidence rather than broadening retry policy to make a pull request green.
