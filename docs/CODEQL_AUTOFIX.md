# CodeQL Autofix automation

This repository consumes the review-only CodeQL Autofix controller from `portyu9/qa-automation-mobile-appium` at immutable commit `9280e1cf79bea79c027eabc8abe355ad89e6c010`. Repository-specific scope is defined in `.github/codeql-autofix.json` and protected by dependency governance.

The controller runs only from trusted default-branch code after a successful `Security` workflow, on a bounded schedule, or by explicit default-branch dispatch. The thin caller wrapper normalizes only the capitalization of that trusted workflow name for compatibility with the canonical controller; SHA, conclusion, branch, repository, and alert checks remain unchanged. Pull requests execute only unprivileged integration self-tests.

Only explicitly targeted open CodeQL alerts on the exact current `main` SHA may be processed. Generated changes are committed to a new isolated security branch and rejected unless they satisfy source-extension, changed-file, changed-line, alert-location, base-SHA, and denied-path limits. Accepted suggestions become draft PRs and the repository's CI and Security workflows are dispatched normally.

The controller never merges, dismisses an alert, force-updates a branch, checks out generated code in its privileged job, or changes denied workflow/dependency policy files. GitHub's explicit `422 Alert is not supported by autofix` result is recorded as an auditable nonfatal outcome; unexpected API, authentication, validation, and unsafe-diff failures remain hard failures.

Historical targets are alerts `#2` and `#3`. Their ReDoS findings were already remediated in PR #50, so a closed-alert no-op is the expected first production result.
