#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  classifyEcosystem,
  eventPullNumber,
  parsePositiveInteger,
  selectQualificationRun,
  validateConfig,
  validateProvenance,
  validateSignedMetadata,
} from './dependency-governance.mjs';

const DEFAULT_GOVERNANCE_CONFIG = '.github/dependency-governance.json';
const DEFAULT_RECOVERY_CONFIG = '.github/dependency-recovery.json';
const PAGE_SIZE = 100;

const TRANSIENT_LOG_SIGNATURES = [
  { id: 'dns-eai-again', pattern: /\bEAI_AGAIN\b/iu },
  { id: 'connection-reset', pattern: /\bECONNRESET\b/iu },
  { id: 'connection-timeout', pattern: /\bETIMEDOUT\b/iu },
  { id: 'socket-timeout', pattern: /\bERR_SOCKET_TIMEOUT\b/iu },
  { id: 'network-unreachable', pattern: /\bENETUNREACH\b/iu },
  { id: 'host-unreachable', pattern: /\bEHOSTUNREACH\b/iu },
  { id: 'socket-hang-up', pattern: /\bsocket hang up\b/iu },
  {
    id: 'http-5xx',
    pattern:
      /(?:server returned code|status(?: code)?|HTTP(?:\/\d(?:\.\d)?)?)\s*[:=]?\s*(?:502|503|504)\b/iu,
  },
  {
    id: 'gateway-service-outage',
    pattern: /\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b/iu,
  },
  {
    id: 'tls-transient',
    pattern: /\bTLS\b.*\b(?:handshake|connection)\b.*\b(?:timeout|timed out|unexpected EOF)\b/iu,
  },
];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function loadJson(filename) {
  return JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8'));
}

export function validateRecoveryConfig(config) {
  const errors = [];
  if (config?.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (typeof config?.enabled !== 'boolean') errors.push('enabled must be boolean');
  if (
    !Number.isInteger(config?.maxRunAttempts) ||
    config.maxRunAttempts < 1 ||
    config.maxRunAttempts > 3
  ) {
    errors.push('maxRunAttempts must be an integer from 1 to 3');
  }
  if (!Array.isArray(config?.transientSteps) || config.transientSteps.length === 0) {
    errors.push('transientSteps must be a non-empty array');
  } else {
    if (config.transientSteps.some((step) => typeof step !== 'string' || step.trim() === '')) {
      errors.push('every transientSteps entry must be a non-empty string');
    }
    if (new Set(config.transientSteps).size !== config.transientSteps.length) {
      errors.push('transientSteps must not contain duplicates');
    }
    for (const forbidden of [
      'Static quality gate',
      'Run framework contract gate',
      'Run accessibility gate',
      'Run smoke suite',
      'Compare against canonical baseline',
      'Evaluate required jobs',
      'Evaluate security jobs',
    ]) {
      if (config.transientSteps.includes(forbidden)) {
        errors.push(`${forbidden} must never be eligible for automatic recovery`);
      }
    }
  }
  return unique(errors);
}

export function matchingTransientSignatures(logs) {
  const text = String(logs || '');
  return TRANSIENT_LOG_SIGNATURES.filter(({ pattern }) => pattern.test(text)).map(({ id }) => id);
}

export function classifyLeafJobFailure(job, logs, recoveryConfig) {
  if (job?.conclusion !== 'failure') {
    return { transient: false, reason: 'job conclusion is not failure', signatures: [] };
  }
  const failedSteps = (job.steps || []).filter((step) => step.conclusion === 'failure');
  if (failedSteps.length !== 1) {
    return {
      transient: false,
      reason: `expected exactly one failed step, found ${failedSteps.length}`,
      signatures: [],
    };
  }
  const failedStep = failedSteps[0];
  if (!recoveryConfig.transientSteps.includes(failedStep.name)) {
    return {
      transient: false,
      reason: `failed step is not allowlisted for transient recovery: ${failedStep.name}`,
      signatures: [],
      failedStep: failedStep.name,
    };
  }
  const signatures = matchingTransientSignatures(logs);
  if (signatures.length === 0) {
    return {
      transient: false,
      reason: `allowlisted infrastructure step has no proven transient network/service signature: ${failedStep.name}`,
      signatures: [],
      failedStep: failedStep.name,
    };
  }
  return {
    transient: true,
    reason: `proven transient infrastructure failure in ${failedStep.name}`,
    signatures,
    failedStep: failedStep.name,
  };
}

export function classifyRunFailure({ run, jobs, logsByJobId, gateName, recoveryConfig }) {
  if (run?.status !== 'completed' || run?.conclusion !== 'failure') {
    return { rerunnable: false, reason: 'workflow run is not a completed failure', failures: [] };
  }
  const runAttempt = Number(run.run_attempt || 1);
  if (runAttempt >= recoveryConfig.maxRunAttempts) {
    return {
      rerunnable: false,
      reason: `workflow run attempt ${runAttempt} reached recovery cap ${recoveryConfig.maxRunAttempts}`,
      failures: [],
    };
  }
  const failedLeafJobs = (jobs || []).filter(
    (job) => job.conclusion === 'failure' && job.name !== gateName,
  );
  if (failedLeafJobs.length === 0) {
    return {
      rerunnable: false,
      reason: 'no failed leaf job exists beneath the stable aggregate gate',
      failures: [],
    };
  }
  const failures = failedLeafJobs.map((job) => ({
    jobId: job.id,
    jobName: job.name,
    ...classifyLeafJobFailure(job, logsByJobId?.[job.id] || '', recoveryConfig),
  }));
  if (failures.some((failure) => failure.transient !== true)) {
    return {
      rerunnable: false,
      reason: 'at least one failed leaf job is deterministic or ambiguous',
      failures,
    };
  }
  return {
    rerunnable: true,
    reason: 'every failed leaf job is a proven transient infrastructure failure',
    failures,
  };
}

class GitHubApi {
  constructor({ token, repository, maxPaginationPages }) {
    if (!token) throw new Error('GITHUB_TOKEN is required');
    if (!repository?.includes('/')) throw new Error('GITHUB_REPOSITORY must be owner/repo');
    this.token = token;
    this.repository = repository;
    this.maxPaginationPages = maxPaginationPages;
    [this.owner, this.repo] = repository.split('/');
    this.root = `https://api.github.com/repos/${this.owner}/${this.repo}`;
  }

  async request(method, pathname, body, { allowConflict = false } = {}) {
    const url = pathname.startsWith('http') ? pathname : `${this.root}${pathname}`;
    const response = await globalThis.fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dependency-recovery-controller',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (allowConflict && response.status === 409) {
      return { conflict: true, status: response.status, payload };
    }
    if (!response.ok) {
      const message = typeof payload === 'object' ? payload?.message : payload;
      throw new Error(
        `GitHub API ${method} ${url} failed (${response.status}): ${message || 'unknown error'}`,
      );
    }
    return payload;
  }

  get(pathname) {
    return this.request('GET', pathname);
  }

  post(pathname, body, options) {
    return this.request('POST', pathname, body, options);
  }

  async text(pathname) {
    const url = pathname.startsWith('http') ? pathname : `${this.root}${pathname}`;
    const response = await globalThis.fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dependency-recovery-controller',
      },
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`GitHub log fetch ${url} failed (${response.status})`);
    }
    return response.text();
  }

  async paginate(pathname, selector = null) {
    const values = [];
    for (let page = 1; page <= this.maxPaginationPages; page += 1) {
      const separator = pathname.includes('?') ? '&' : '?';
      const payload = await this.get(`${pathname}${separator}per_page=${PAGE_SIZE}&page=${page}`);
      const pageValues = selector ? payload?.[selector] : payload;
      if (!Array.isArray(pageValues)) {
        throw new Error(`pagination endpoint ${pathname} did not return ${selector || 'an array'}`);
      }
      values.push(...pageValues);
      if (pageValues.length < PAGE_SIZE) return values;
    }
    throw new Error(
      `pagination safety limit reached for ${pathname} after ${this.maxPaginationPages} page(s)`,
    );
  }
}

async function getCurrentBaseSha(api, branch) {
  const ref = await api.get(`/git/ref/heads/${encodeURIComponent(branch)}`);
  return ref.object.sha;
}

async function getPull(api, number) {
  return api.get(`/pulls/${number}`);
}

async function getPullCommits(api, pull) {
  if (pull.commits > 100) {
    throw new Error(`PR contains ${pull.commits} commits; refusing oversized recovery input`);
  }
  return api.get(`/pulls/${pull.number}/commits?per_page=100`);
}

async function getPullFiles(api, pull) {
  if (pull.changed_files > 100) {
    throw new Error(`PR changes ${pull.changed_files} files; refusing oversized recovery input`);
  }
  return api.get(`/pulls/${pull.number}/files?per_page=100`);
}

export function recoveryScopeAssessment({
  pull,
  files,
  provenance,
  metadataAssessment,
  governanceConfig,
}) {
  const reasons = [];
  if (!provenance.eligible) reasons.push(...provenance.reasons);
  if (!metadataAssessment.eligible) reasons.push(...metadataAssessment.reasons);
  if (pull.changed_files !== files.length) {
    reasons.push(
      `GitHub reports ${pull.changed_files} changed files but ${files.length} were enumerated`,
    );
  }
  if (files.length > governanceConfig.maxChangedFiles) {
    reasons.push(
      `PR changes ${files.length} files, exceeding autonomous limit ${governanceConfig.maxChangedFiles}`,
    );
  }
  const filenames = files.map((file) => file.filename);
  const protectedPaths = filenames.filter((filename) =>
    governanceConfig.manualReviewPaths.includes(filename),
  );
  if (protectedPaths.length) {
    reasons.push(`recovery is disabled for control-plane path(s): ${protectedPaths.join(', ')}`);
  }
  const ecosystem = classifyEcosystem(files, governanceConfig);
  if (ecosystem === 'unknown') {
    reasons.push('changed-file set does not map to one allowlisted dependency ecosystem');
  }
  return { eligible: reasons.length === 0, reasons: unique(reasons), ecosystem };
}

async function recoveryQualificationRuns(api, pull, governanceConfig) {
  const runs = await api.paginate(
    `/actions/runs?head_sha=${encodeURIComponent(pull.head.sha)}&event=pull_request`,
    'workflow_runs',
  );
  return governanceConfig.requiredWorkflows.map((requirement) => ({
    requirement,
    run: selectQualificationRun(runs, pull, requirement),
  }));
}

async function classifyRequirementFailure(api, requirement, run, recoveryConfig) {
  if (!run || run.status !== 'completed' || run.conclusion !== 'failure') {
    return {
      workflow: requirement.workflow,
      runId: run?.id || null,
      rerunnable: false,
      reason: 'required workflow is not a completed failure',
      failures: [],
    };
  }
  const jobs = await api.paginate(`/actions/runs/${run.id}/jobs?filter=latest`, 'jobs');
  const failedLeafJobs = jobs.filter(
    (job) => job.conclusion === 'failure' && job.name !== requirement.gate,
  );
  const logsByJobId = {};
  for (const job of failedLeafJobs) {
    try {
      logsByJobId[job.id] = await api.text(`/actions/jobs/${job.id}/logs`);
    } catch (error) {
      logsByJobId[job.id] = '';
      console.log(`Recovery log unavailable for job ${job.id}: ${error.message}`);
    }
  }
  return {
    workflow: requirement.workflow,
    runId: run.id,
    ...classifyRunFailure({
      run,
      jobs,
      logsByJobId,
      gateName: requirement.gate,
      recoveryConfig,
    }),
  };
}

async function recoverPull(api, number, governanceConfig, recoveryConfig, allowRerun) {
  const pull = await getPull(api, number);
  if (
    pull.user?.login !== governanceConfig.botLogin ||
    pull.user?.id !== governanceConfig.botUserId
  ) {
    return { pr: number, skipped: true, reason: 'not canonical Dependabot' };
  }
  if (pull.state !== 'open') {
    return { pr: number, skipped: true, reason: `pull request state is ${pull.state}` };
  }

  const baseSha = await getCurrentBaseSha(api, governanceConfig.baseBranch);
  const [commits, files] = await Promise.all([getPullCommits(api, pull), getPullFiles(api, pull)]);
  const provenance = validateProvenance({
    pull,
    commits,
    baseSha,
    config: governanceConfig,
  });
  const metadataAssessment = provenance.commit
    ? validateSignedMetadata(provenance.commit, governanceConfig)
    : { eligible: false, reasons: ['no single verified Dependabot commit'], metadata: [] };
  const scope = recoveryScopeAssessment({
    pull,
    files,
    provenance,
    metadataAssessment,
    governanceConfig,
  });
  if (!recoveryConfig.enabled) {
    return { pr: number, skipped: true, reason: 'recovery kill switch is disabled', scope };
  }
  if (!scope.eligible) {
    const staleOnly =
      provenance.reasons.length === 1 &&
      provenance.reasons[0] === 'PR is not rebased directly on the current base branch head';
    return {
      pr: number,
      skipped: true,
      reason: staleOnly
        ? 'waiting for Dependabot native auto-rebase; controller never mutates Dependabot branches'
        : 'recovery scope is not eligible',
      scope,
    };
  }

  const qualifications = await recoveryQualificationRuns(api, pull, governanceConfig);
  const failures = [];
  for (const { requirement, run } of qualifications) {
    if (run?.status === 'completed' && run?.conclusion === 'failure') {
      failures.push(await classifyRequirementFailure(api, requirement, run, recoveryConfig));
    }
  }
  const actions = [];
  for (const failure of failures) {
    if (!failure.rerunnable) continue;
    if (!allowRerun) {
      actions.push({
        workflow: failure.workflow,
        runId: failure.runId,
        state: 'dry-run',
        reason: failure.reason,
      });
      continue;
    }
    const rerun = await api.post(`/actions/runs/${failure.runId}/rerun-failed-jobs`, undefined, {
      allowConflict: true,
    });
    actions.push({
      workflow: failure.workflow,
      runId: failure.runId,
      state: rerun?.conflict ? 'already-running' : 'rerun-requested',
      reason: failure.reason,
      failures: failure.failures.map((item) => ({
        job: item.jobName,
        step: item.failedStep,
        signatures: item.signatures,
      })),
    });
  }
  return {
    pr: number,
    skipped: false,
    head: pull.head.sha,
    scope,
    failures,
    actions,
  };
}

async function resolveWorkflowRunPull(api, event) {
  const direct = event.workflow_run?.pull_requests?.[0]?.number;
  if (direct) return direct;
  const branch = event.workflow_run?.head_branch;
  if (!branch) return null;
  const pulls = await api.paginate(
    `/pulls?state=open&head=${encodeURIComponent(`${api.owner}:${branch}`)}`,
  );
  return pulls.length === 1 ? pulls[0].number : null;
}

async function main() {
  const governancePath = process.env.GOVERNANCE_CONFIG || DEFAULT_GOVERNANCE_CONFIG;
  const recoveryPath = process.env.RECOVERY_CONFIG || DEFAULT_RECOVERY_CONFIG;
  const governanceConfig = loadJson(governancePath);
  const governanceErrors = validateConfig(governanceConfig);
  if (governanceErrors.length) {
    throw new Error(`Invalid dependency governance config:\n- ${governanceErrors.join('\n- ')}`);
  }
  const recoveryConfig = loadJson(recoveryPath);
  const recoveryErrors = validateRecoveryConfig(recoveryConfig);
  if (recoveryErrors.length) {
    throw new Error(`Invalid dependency recovery config:\n- ${recoveryErrors.join('\n- ')}`);
  }
  if (process.argv.includes('--validate-config')) {
    console.log('dependency-recovery config: valid');
    return;
  }

  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventName || !eventPath) {
    throw new Error('GITHUB_EVENT_NAME and GITHUB_EVENT_PATH are required');
  }
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const api = new GitHubApi({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    maxPaginationPages: governanceConfig.maxPaginationPages,
  });
  const allowRerun = process.env.ALLOW_RECOVERY_RERUN === 'true';

  if (eventName === 'schedule') {
    const pulls = await api.paginate('/pulls?state=open');
    const dependabotPulls = pulls.filter(
      (pull) =>
        pull.user?.login === governanceConfig.botLogin &&
        pull.user?.id === governanceConfig.botUserId,
    );
    const results = [];
    for (const pull of dependabotPulls) {
      try {
        results.push(
          await recoverPull(api, pull.number, governanceConfig, recoveryConfig, allowRerun),
        );
      } catch (error) {
        results.push({ pr: pull.number, error: error.message });
      }
    }
    console.log(JSON.stringify({ recovery: results }, null, 2));
    if (results.some((item) => item.error)) {
      throw new Error('scheduled dependency recovery encountered one or more controller errors');
    }
    return;
  }

  let number = eventPullNumber(event, eventName);
  if (!number && eventName === 'workflow_run') number = await resolveWorkflowRunPull(api, event);
  if (!number && eventName === 'workflow_dispatch') {
    const value = event.inputs?.['pr-number'];
    number = value == null || value === '' ? null : parsePositiveInteger(value, 'pr-number');
  }
  if (!number) {
    console.log(`No pull request resolved for ${eventName}; recovery has nothing to do.`);
    return;
  }
  const result = await recoverPull(api, number, governanceConfig, recoveryConfig, allowRerun);
  console.log(JSON.stringify({ recovery: result }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
