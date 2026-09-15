# Dependabot Recovery Contract

## Purpose

Dependency recovery handles one narrow operational problem: a routine, already-governable Dependabot pull request can fail qualification because hosted infrastructure or an external package service had a transient outage. Recovery may remove that operational noise, but it must never reinterpret a real test, security, compatibility, visual, accessibility, provenance, or policy failure as transient.

The dependency-governance workflow remains the only autonomous merge authority. Recovery can request one bounded rerun of failed jobs in an existing qualification workflow; it can never approve or merge a pull request.

## Trust boundary

Recovery executes only from trusted code checked out from the default branch. It reuses the dependency-governance identity proof before considering any action: canonical Dependabot account identity, exactly one GitHub-verified signed Dependabot commit, canonical author/committer identities, signed update metadata, one parent equal to the current `main` head, and an allowlisted dependency ecosystem.

The recovery policy does not store, parse, or construct authentication headers. The privileged workflow invokes an immutable-SHA-pinned `actions/github-script` action and passes its authenticated GitHub client, event context, and logging interface into the repository-owned recovery module. The module can inspect qualification evidence and request a failed-job rerun through that injected client; merge authority remains in the separate dependency-governance step.

The controller never checks out or executes privileged recovery logic from the Dependabot branch. It never pushes to a Dependabot branch, calls GitHub's update-branch endpoint, synthesizes commits, rewrites lockfiles, edits source, or comments `@dependabot recreate` from automation. Stale PRs use Dependabot's native `rebase-strategy: auto` and remain ineligible until a fresh signed Dependabot commit is directly based on current `main`.

Control-plane changes are outside recovery. `.github/dependabot.yml`, governance/recovery configuration, governance/recovery policy modules and self-checks, and privileged workflows remain manual-review paths.

## Retry decision

A required qualification workflow may be rerun only when every condition below is true:

1. the exact-head workflow run completed with conclusion `failure`;
2. its `run_attempt` is below the configured cap of two, allowing at most one automatic rerun;
3. exactly one job with the configured stable aggregate-gate name exists and that gate itself concluded `failure`;
4. every non-gate job has a terminal conclusion of `success`, `skipped`, or `failure`; cancelled, timed-out, neutral, action-required, stale, missing, or otherwise unknown sibling states hard-stop recovery;
5. at least one non-aggregate leaf job failed;
6. every failed leaf job has exactly one failed step;
7. every failed step is an explicitly allowlisted infrastructure operation such as dependency installation, runtime/browser setup, or evidence upload;
8. the failed step has valid `started_at` and `completed_at` timestamps and the raw job log contains timestamped lines attributable to that exact execution window;
9. only that failed-step log window is searched for recovery evidence; transient-looking text from an earlier successful step or later cleanup cannot authorize a rerun;
10. the failed-step window contains a narrow modeled transient transport/service signature such as `EAI_AGAIN`, `ECONNRESET`, `ETIMEDOUT`, a contextual HTTP 502/503/504 response, or an equivalent explicitly modeled transport failure;
11. the same failed-step window contains no deterministic or policy-blocking signature such as npm resolution/lock errors, HTTP client/auth/policy errors, permission failures, or disk-space exhaustion; a blocker always outranks a transient-looking string.

The controller reruns only failed jobs in that existing exact-head workflow run. It does not create a substitute qualification run with different inputs or a different commit.

## Fail-closed cases

Automatic recovery is forbidden for static-quality failures, framework-contract failures, smoke tests, accessibility tests, visual comparisons, scanner/audit execution or findings, aggregate-gate ambiguity, multiple failed steps in one job, mixed transient and deterministic evidence, missing or malformed step timing, missing/unattributable logs, unrecognized errors, ambiguous sibling-job conclusions, a second failed run attempt, noncanonical provenance, stale base ancestry, major/downgrade/prerelease/unknown updates, or control-plane changes.

A network-looking string inside a functional or security failure does not make the failure transient: step identity is checked before any signature, only the failed step's timestamp-bounded log window is considered, and explicit deterministic evidence wins. Generic phrases such as `Service Unavailable` without a precise modeled status/transport signature are intentionally insufficient.

## State machine

A routine dependency update therefore moves through this bounded path:

`Dependabot proposal -> provenance/semantic eligibility -> exact-head qualification -> optional one-time proven-transient failed-job rerun -> exact-head qualification success -> dependency governance merge`

A stale proposal instead follows:

`stale Dependabot head -> native Dependabot auto-rebase -> new signed single commit -> normal qualification`

Any deterministic, ambiguous, or incompletely attributable failure follows:

`failure -> hard stop -> evidence remains red for investigation`

There is no automatic branch mutation or source-code repair path.

## False-positive controls

The recovery self-check suite exercises both positive and adversarial cases. It proves that a known transient signature can authorize a retry only inside the failed execution window of an allowlisted infrastructure step. The same strings are rejected when they occur in functional/security steps, earlier successful steps, or a failed step that also contains deterministic blocker evidence.

The suite also covers mixed failures, multiple failed steps, aggregate-gate ambiguity, cancelled/timed-out/neutral/unknown sibling jobs, attempt exhaustion, unsupported workflow conclusions, missing/malformed timestamps, unknown file scope, control-plane paths, stale provenance, injected-client orchestration, positive one-rerun mutation, and dry-run no-mutation behavior.

Configuration contains a kill switch (`enabled`) and the attempt cap. Expansion of transient steps or signatures is a privileged policy change and must pass the same manual control-plane review as dependency governance itself.

## Operational interpretation

A recovery rerun is not evidence that the dependency is safe; it only acknowledges that the first qualification attempt was provably inconclusive because of a modeled infrastructure incident. The rerun must still produce the repository's ordinary stable CI and Security gates on the exact Dependabot head. Governance then independently re-evaluates provenance, semantic scope, base freshness, and exact-head qualification before any merge.

If the second attempt fails, if the failure class is not modeled, or if evidence is incomplete, automation stops. Operators investigate the original evidence rather than broadening retry policy to make a pull request green.
