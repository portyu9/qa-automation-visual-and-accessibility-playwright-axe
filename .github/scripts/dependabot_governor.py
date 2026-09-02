#!/usr/bin/env python3
from __future__ import annotations

import fnmatch
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

API = "https://api.github.com"
SAFE_CONCLUSIONS = {"success", "neutral", "skipped"}
BOT_LOGIN = "dependabot[bot]"
BOT_USER_ID = 49699333
BOT_AUTHOR_EMAIL = "49699333+dependabot[bot]@users.noreply.github.com"
TRUSTED_COMMITTER_LOGIN = "web-flow"
GIT_COMMITTER_NAME = "GitHub"
GIT_COMMITTER_EMAIL = "noreply@github.com"
SIGNED_OFF_BY = "Signed-off-by: dependabot[bot] <support@github.com>"


class Block(RuntimeError):
    """An expected fail-closed governance decision."""


class Error(RuntimeError):
    """An unexpected governance infrastructure failure."""


def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise Error(f"{name} is empty")
    return value


def csv(name: str) -> tuple[str, ...]:
    return tuple(
        item.strip()
        for item in os.environ.get(name, "").split(",")
        if item.strip()
    )


def lines(name: str) -> tuple[str, ...]:
    return tuple(
        item.strip()
        for item in os.environ.get(name, "").splitlines()
        if item.strip()
    )


@dataclass(frozen=True)
class Policy:
    repo: str
    required_workflows: tuple[str, ...]
    groups: tuple[str, ...]
    allowed_paths: tuple[str, ...]
    manual_review_paths: tuple[str, ...]
    allowed_update_types: tuple[str, ...]
    block_labels: tuple[str, ...]
    merge_method: str
    max_files: int = 25

    @classmethod
    def load(cls) -> "Policy":
        policy = cls(
            repo=env("GITHUB_REPOSITORY"),
            required_workflows=csv("GOVERNOR_REQUIRED_WORKFLOWS"),
            groups=csv("GOVERNOR_ALLOWED_GROUPS"),
            allowed_paths=lines("GOVERNOR_ALLOWED_PATHS"),
            manual_review_paths=lines("GOVERNOR_MANUAL_REVIEW_PATHS"),
            allowed_update_types=csv("GOVERNOR_ALLOWED_UPDATE_TYPES"),
            block_labels=csv("GOVERNOR_BLOCK_LABELS"),
            merge_method=os.environ.get("GOVERNOR_MERGE_METHOD", "merge").strip(),
        )
        if (
            not policy.required_workflows
            or not policy.groups
            or not policy.allowed_paths
            or not policy.allowed_update_types
        ):
            raise Error("governor policy lists must not be empty")
        if policy.merge_method not in {"merge", "rebase", "squash"}:
            raise Error(f"bad merge method {policy.merge_method}")
        if policy.repo.count("/") != 1:
            raise Error("GITHUB_REPOSITORY must be owner/repo")
        return policy


class GitHub:
    def __init__(self, token: str):
        self.token = token

    def call(self, method: str, path: str, payload: dict | None = None):
        request = urllib.request.Request(
            API + path,
            data=None if payload is None else json.dumps(payload).encode(),
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "dependabot-governor",
                **({"Content-Type": "application/json"} if payload is not None else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            raise Error(
                f"GitHub API {method} {path} failed {exc.code}: {detail}"
            ) from exc
        except OSError as exc:
            raise Error(f"GitHub API {method} {path} failed: {exc}") from exc
        return json.loads(raw) if raw else None

    def get(self, path: str):
        return self.call("GET", path)

    def put(self, path: str, payload: dict):
        return self.call("PUT", path, payload)


def event() -> dict:
    with open(env("GITHUB_EVENT_PATH"), encoding="utf-8") as handle:
        return json.load(handle)


def resolve(trigger: dict) -> tuple[int, str | None, str | None]:
    name = env("GITHUB_EVENT_NAME")
    if name == "workflow_dispatch":
        value = str(trigger.get("inputs", {}).get("pr_number", "")).strip()
        if not value.isdigit():
            raise Error("workflow_dispatch requires numeric pr_number")
        return int(value), None, None
    if name != "workflow_run":
        raise Block(f"{name} is not a governance event")

    run = trigger.get("workflow_run") or {}
    pulls = run.get("pull_requests") or []
    if run.get("event") != "pull_request":
        raise Block("triggering workflow was not a pull_request run")
    if len(pulls) != 1 or not isinstance(pulls[0].get("number"), int):
        raise Block("workflow run is not associated with exactly one PR")
    return (
        pulls[0]["number"],
        run.get("head_sha"),
        ((pulls[0].get("base") or {}).get("sha")),
    )


def allowed(path: str, patterns: tuple[str, ...]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def files_ok(items: list[dict], policy: Policy) -> list[str]:
    names = [str(item.get("filename", "")) for item in items]
    if not names:
        raise Block("PR has no files")
    if len(names) > policy.max_files:
        raise Block(
            f"PR changes {len(names)} files; limit is {policy.max_files}"
        )

    manual = [
        name
        for name in names
        if allowed(name, policy.manual_review_paths)
    ]
    if manual:
        raise Block(
            "control-plane paths require manual review: " + ", ".join(manual)
        )

    blocked = [
        name for name in names if not allowed(name, policy.allowed_paths)
    ]
    if blocked:
        raise Block("non-dependency file scope: " + ", ".join(blocked))
    return names


def _unquote(value: str) -> str:
    text = value.strip()
    if (
        len(text) >= 2
        and text[0] == text[-1]
        and text[0] in {"'", '"'}
    ):
        return text[1:-1]
    return text


def parse_dependabot_metadata(message: str) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    in_block = False

    for line in str(message or "").splitlines():
        if line.strip() == "updated-dependencies:":
            in_block = True
            continue
        if not in_block:
            continue
        if line.strip() == "...":
            break

        match = re.match(r"\s*-\s+dependency-name:\s*(.+?)\s*$", line)
        if match:
            if current:
                result.append(current)
            current = {"name": _unquote(match.group(1))}
            continue
        if not current:
            continue

        for key, field in (
            ("version", "dependency-version"),
            ("dependency_type", "dependency-type"),
            ("update_type", "update-type"),
            ("group", "dependency-group"),
        ):
            match = re.match(rf"\s+{re.escape(field)}:\s*(.+?)\s*$", line)
            if match:
                current[key] = _unquote(match.group(1))

    if current:
        result.append(current)
    return result


def provenance_ok(
    pull: dict,
    commits: list[dict],
    current_main: str,
    policy: Policy,
) -> None:
    user = pull.get("user") or {}
    if (
        user.get("login") != BOT_LOGIN
        or user.get("id") != BOT_USER_ID
    ):
        raise Block("PR author is not the canonical Dependabot account")

    base = pull.get("base") or {}
    head = pull.get("head") or {}
    if base.get("ref") != "main":
        raise Block("base is not main")
    if (base.get("repo") or {}).get("full_name") != policy.repo:
        raise Block("base repository is not this repository")
    if (head.get("repo") or {}).get("full_name") != policy.repo:
        raise Block("Dependabot head repository is not this repository")
    if not str(head.get("ref") or "").startswith("dependabot/"):
        raise Block("head branch is not a Dependabot branch")

    labels = {
        item if isinstance(item, str) else item.get("name")
        for item in (pull.get("labels") or [])
    }
    blocked_labels = sorted(
        label for label in policy.block_labels if label in labels
    )
    if blocked_labels:
        raise Block(
            "PR carries manual-review label(s): "
            + ", ".join(blocked_labels)
        )

    if len(commits) != 1:
        raise Block(
            "expected exactly one untouched Dependabot commit; "
            f"found {len(commits)}"
        )
    commit = commits[0]
    head_sha = str(head.get("sha") or "")
    if commit.get("sha") != head_sha:
        raise Block("Dependabot commit SHA does not equal current PR head")

    parents = commit.get("parents") or []
    if (
        len(parents) != 1
        or (parents[0] or {}).get("sha") != current_main
    ):
        raise Block("Dependabot commit parent is not current main")

    git = commit.get("commit") or {}
    author = git.get("author") or {}
    committer = git.get("committer") or {}
    materialized_author = commit.get("author") or {}
    materialized_committer = commit.get("committer") or {}

    if (
        author.get("name") != BOT_LOGIN
        or author.get("email") != BOT_AUTHOR_EMAIL
    ):
        raise Block("Git author is not the canonical Dependabot identity")
    if (
        materialized_author.get("login") != BOT_LOGIN
        or materialized_author.get("id") != BOT_USER_ID
    ):
        raise Block("materialized commit author is not Dependabot")
    if materialized_committer.get("login") != TRUSTED_COMMITTER_LOGIN:
        raise Block("materialized commit committer is not GitHub web-flow")
    if (
        committer.get("name") != GIT_COMMITTER_NAME
        or committer.get("email") != GIT_COMMITTER_EMAIL
    ):
        raise Block("Git committer is not canonical GitHub")

    verification = git.get("verification") or {}
    if (
        verification.get("verified") is not True
        or verification.get("reason") != "valid"
        or not str(verification.get("signature") or "").strip()
        or not str(verification.get("payload") or "").strip()
    ):
        raise Block("Dependabot commit signature is not fully verified")

    message = str(git.get("message") or "")
    if SIGNED_OFF_BY not in message.splitlines():
        raise Block("canonical Dependabot Signed-off-by trailer is missing")

    metadata = parse_dependabot_metadata(message)
    if not metadata:
        raise Block("signed Dependabot updated-dependencies metadata is missing")
    for dependency in metadata:
        name = dependency.get("name") or "<unknown>"
        update_type = dependency.get("update_type")
        group = dependency.get("group")
        if update_type not in policy.allowed_update_types:
            raise Block(
                f"{name} update type {update_type or 'missing'} "
                "is not autonomously allowed"
            )
        if group not in policy.groups:
            raise Block(
                f"{name} dependency group {group or 'missing'} "
                "is not autonomously allowed"
            )


def runs_ok(
    runs: list[dict],
    required: tuple[str, ...],
    current_main: str,
) -> None:
    latest: dict[str, dict] = {}
    for run in runs:
        path = str(run.get("path", ""))
        if path and path not in latest:
            latest[path] = run

    missing = [path for path in required if path not in latest]
    if missing:
        raise Block(
            "required workflows have not started: " + ", ".join(missing)
        )

    for path in required:
        run = latest[path]
        if run.get("status") != "completed":
            raise Block(f"required workflow still running: {path}")
        if run.get("conclusion") != "success":
            raise Block(
                f"required workflow failed: {path}={run.get('conclusion')}"
            )
        pulls = run.get("pull_requests") or []
        base = (
            ((pulls[0].get("base") or {}).get("sha"))
            if len(pulls) == 1
            else None
        )
        if base != current_main:
            raise Block(
                f"{path} tested obsolete base {base or 'unknown'}"
            )

    for run in runs:
        path = str(run.get("path", "<unknown>"))
        if run.get("status") != "completed":
            raise Block(f"PR workflow still running: {path}")
        if run.get("conclusion") not in SAFE_CONCLUSIONS:
            raise Block(
                f"PR workflow not green: "
                f"{path}={run.get('conclusion')}"
            )


def summary(items: list[str]) -> None:
    filename = os.environ.get("GITHUB_STEP_SUMMARY")
    if filename:
        with open(filename, "a", encoding="utf-8") as handle:
            handle.write("\n".join(items) + "\n")


def govern() -> None:
    policy = Policy.load()
    github = GitHub(env("GITHUB_TOKEN"))
    number, trigger_sha, trigger_base = resolve(event())
    pull = github.get(f"/repos/{policy.repo}/pulls/{number}")

    if pull.get("state") != "open":
        raise Block("PR is not open")
    if pull.get("draft"):
        raise Block("draft PR")

    head = (pull.get("head") or {}).get("sha")
    if not head:
        raise Error("missing PR head SHA")
    if trigger_sha and trigger_sha != head:
        raise Block("workflow belongs to obsolete PR head")

    main = (
        (
            github.get(f"/repos/{policy.repo}/branches/main").get("commit")
            or {}
        ).get("sha")
    )
    if not main:
        raise Error("missing main SHA")
    if trigger_base and trigger_base != main:
        raise Block(
            "triggering workflow tested obsolete main; "
            "wait for Dependabot rebase"
        )

    commits = github.get(
        f"/repos/{policy.repo}/pulls/{number}/commits?per_page=100"
    )
    if not isinstance(commits, list):
        raise Error("pull request commits endpoint did not return a list")
    provenance_ok(pull, commits, main, policy)

    files = github.get(
        f"/repos/{policy.repo}/pulls/{number}/files?per_page=100"
    )
    if not isinstance(files, list):
        raise Error("pull request files endpoint did not return a list")
    names = files_ok(files, policy)

    query = urllib.parse.urlencode(
        {
            "head_sha": head,
            "event": "pull_request",
            "per_page": 100,
        }
    )
    runs_payload = github.get(
        f"/repos/{policy.repo}/actions/runs?{query}"
    )
    runs = (runs_payload or {}).get("workflow_runs") or []
    runs_ok(runs, policy.required_workflows, main)

    if pull.get("mergeable") is not True:
        raise Block("GitHub has not confirmed the PR is mergeable")

    result = github.put(
        f"/repos/{policy.repo}/pulls/{number}/merge",
        {
            "sha": head,
            "merge_method": policy.merge_method,
            "commit_title": str(
                pull.get("title", "Dependabot routine update")
            ),
            "commit_message": (
                "Automatically qualified by the repository "
                "Dependabot governor.\n\n"
                f"PR #{number}; exact head {head}; "
                "verified untouched Dependabot provenance; "
                f"required workflows: "
                f"{', '.join(policy.required_workflows)}."
            ),
        },
    )
    if not result or not result.get("merged"):
        raise Error(f"merge rejected: {result}")

    summary(
        [
            "## Dependabot governor",
            "",
            f"- Decision: **merged** PR #{number}",
            f"- Exact head: `{head}`",
            "- Provenance: verified untouched Dependabot commit",
            f"- Merge method: `{policy.merge_method}`",
            "- Files: "
            + ", ".join(f"`{name}`" for name in names),
        ]
    )
    print(f"merged Dependabot PR #{number} at {head}")


def _expect_block(callable_, contains: str) -> None:
    try:
        callable_()
    except Block as exc:
        assert contains in str(exc), (contains, str(exc))
    else:
        raise AssertionError(f"expected Block containing {contains!r}")


def _fixture_message(
    update_type: str = "version-update:semver-minor",
    group: str = "toolchain",
) -> str:
    return (
        "deps(deps-dev): bump example\n\n"
        "updated-dependencies:\n"
        '- dependency-name: "example"\n'
        "  dependency-version: 2.0.0\n"
        "  dependency-type: direct:development\n"
        f"  update-type: {update_type}\n"
        f"  dependency-group: {group}\n"
        "...\n\n"
        f"{SIGNED_OFF_BY}"
    )


def _fixture_commit(
    *,
    sha: str = "h",
    parent: str = "m",
    update_type: str = "version-update:semver-minor",
    group: str = "toolchain",
) -> dict:
    return {
        "sha": sha,
        "parents": [{"sha": parent}],
        "author": {"login": BOT_LOGIN, "id": BOT_USER_ID},
        "committer": {"login": TRUSTED_COMMITTER_LOGIN},
        "commit": {
            "author": {
                "name": BOT_LOGIN,
                "email": BOT_AUTHOR_EMAIL,
            },
            "committer": {
                "name": GIT_COMMITTER_NAME,
                "email": GIT_COMMITTER_EMAIL,
            },
            "message": _fixture_message(update_type, group),
            "verification": {
                "verified": True,
                "reason": "valid",
                "signature": "signature",
                "payload": "payload",
            },
        },
    }


def _fixture_pull() -> dict:
    return {
        "user": {"login": BOT_LOGIN, "id": BOT_USER_ID},
        "labels": [],
        "base": {
            "ref": "main",
            "repo": {"full_name": "o/r"},
        },
        "head": {
            "ref": "dependabot/npm_and_yarn/toolchain-deadbeef",
            "sha": "h",
            "repo": {"full_name": "o/r"},
        },
    }


def self_test() -> None:
    policy = Policy(
        repo="o/r",
        required_workflows=("ci", "security"),
        groups=("toolchain", "routine-actions"),
        allowed_paths=(
            "package.json",
            "package-lock.json",
            ".github/workflows/*.yml",
        ),
        manual_review_paths=(
            ".github/workflows/security.yml",
            ".github/workflows/dependabot-governor.yml",
        ),
        allowed_update_types=(
            "version-update:semver-patch",
            "version-update:semver-minor",
            "security-update:semver-patch",
            "security-update:semver-minor",
        ),
        block_labels=("manual-review", "do-not-merge"),
        merge_method="merge",
    )

    assert files_ok([{"filename": "package.json"}], policy) == [
        "package.json"
    ]
    _expect_block(
        lambda: files_ok(
            [{"filename": ".github/workflows/security.yml"}],
            policy,
        ),
        "control-plane",
    )
    _expect_block(
        lambda: files_ok([{"filename": "README.md"}], policy),
        "non-dependency",
    )

    pull = _fixture_pull()
    commit = _fixture_commit()
    provenance_ok(pull, [commit], "m", policy)

    tampered = _fixture_commit()
    tampered["author"] = {"login": "human", "id": 1}
    _expect_block(
        lambda: provenance_ok(pull, [tampered], "m", policy),
        "materialized commit author",
    )
    _expect_block(
        lambda: provenance_ok(
            pull,
            [
                _fixture_commit(
                    update_type="version-update:semver-major"
                )
            ],
            "m",
            policy,
        ),
        "not autonomously allowed",
    )
    _expect_block(
        lambda: provenance_ok(
            pull,
            [_fixture_commit(parent="old-main")],
            "m",
            policy,
        ),
        "current main",
    )
    unsigned = _fixture_commit()
    unsigned["commit"]["verification"]["verified"] = False
    _expect_block(
        lambda: provenance_ok(pull, [unsigned], "m", policy),
        "signature",
    )

    good_runs = [
        {
            "path": "ci",
            "status": "completed",
            "conclusion": "success",
            "pull_requests": [{"base": {"sha": "m"}}],
        },
        {
            "path": "security",
            "status": "completed",
            "conclusion": "success",
            "pull_requests": [{"base": {"sha": "m"}}],
        },
    ]
    runs_ok(good_runs, policy.required_workflows, "m")
    for conclusion in (
        "failure",
        "cancelled",
        "timed_out",
        "action_required",
    ):
        bad_runs = [dict(item) for item in good_runs]
        bad_runs[1] = {
            **bad_runs[1],
            "conclusion": conclusion,
        }
        _expect_block(
            lambda bad_runs=bad_runs: runs_ok(
                bad_runs,
                policy.required_workflows,
                "m",
            ),
            "required workflow failed",
        )

    print("dependabot governor self-test: ok")


def main() -> int:
    if "--self-test" in sys.argv:
        self_test()
        return 0
    try:
        govern()
        return 0
    except Block as exc:
        summary(
            [
                "## Dependabot governor",
                "",
                "- Decision: **no merge**",
                f"- Reason: {exc}",
            ]
        )
        print(f"policy no-op: {exc}")
        return 0
    except Error as exc:
        print(f"policy error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
