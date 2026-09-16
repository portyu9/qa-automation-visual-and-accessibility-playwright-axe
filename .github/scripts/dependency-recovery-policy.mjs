import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import {
  classifyEcosystem,
  selectQualificationRun,
  validateConfig,
  validateProvenance,
  validateSignedMetadata,
} from './dependency-governance.mjs';

const PAGE_SIZE = 100;
const TERMINAL_NONBLOCKING_CONCLUSIONS = new Set(['success', 'skipped']);
const LOG_TIMESTAMP = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;
const SAFE_TRANSIENT_STEPS = new Set([
  'Checkout',
  'Set up Node.js',
  'Pin npm runtime',
  'Install dependencies',
  'Install Chromium',
  'Install browser',
  'Upload framework evidence',
  'Upload accessibility evidence',
  'Upload smoke evidence',
  'Upload visual comparison evidence',
  'Upload npm audit evidence',
  'Upload Trivy security evidence',
]);

const NON_TRANSIENT_LOG_SIGNATURES = [
  { id: 'npm-resolution', pattern: /\b(?:ERESOLVE|ELSPROBLEMS|EBADENGINE|EUSAGE)\b/iu },
  { id: 'npm-no-matching-version', pattern: /\bNo matching version found\b/iu },
  {
    id: 'npm-lock-mismatch',
    matcher: matchesNpmLockMismatch,
  },
  {
    id: 'http-client-or-policy',
    pattern:
      /(?:server returned code|status(?: code)?|HTTP(?:\/\d(?:\.\d)?)?)\s*[:=]?\s*(?:400|401|403|404|409|422|429)\b/iu,
  },
  { id: 'permission-denied', pattern: /\b(?:EACCES|EPERM)\b/iu },
  { id: 'disk-space', pattern: /\bENOSPC\b/iu },
];

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
    matcher: matchesTlsTransient,
  },
];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function anyLogLineMatches(text, predicate) {
  const normalized = String(text || '').toLowerCase();
  let start = 0;
  while (start <= normalized.length) {
    const newline = normalized.indexOf('\n', start);
    const end = newline === -1 ? normalized.length : newline;
    if (predicate(normalized.slice(start, end))) return true;
    if (newline === -1) return false;
    start = newline + 1;
  }
  return false;
}

function matchesNpmLockMismatch(text) {
  return anyLogLineMatches(
    text,
    (line) =>
      (line.includes('package.json') &&
        line.includes('package-lock.json') &&
        line.includes('not in sync')) ||
      (line.includes('npm ci') && line.includes('lock')),
  );
}

function matchesTlsTransient(text) {
  return anyLogLineMatches(
    text,
    (line) =>
      line.includes('tls') &&
      (line.includes('handshake') || line.includes('connection')) &&
      (line.includes('timeout') || line.includes('timed out') || line.includes('unexpected eof')),
  );
}

function signatureMatches(signature, text) {
  return typeof signature.matcher === 'function'
    ? signature.matcher(text)
    : signature.pattern.test(text);
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function positiveInteger(value, name) {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/u.test(text)) throw new Error(`${name} must be a positive integer`);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} exceeds the safe integer range`);
  return number;
}

function loadJson(filename) {
  return JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8'));
}

export function extractStepLogWindow(logs, step) {
  const startedAt = parseTimestamp(step?.started_at);
  const completedAt = parseTimestamp(step?.completed_at);
  if (startedAt == null || completedAt == null || completedAt < startedAt) return null;

  const selected = [];
  for (const line of String(logs || '').split(/\r?\n/u)) {
    const match = line.match(LOG_TIMESTAMP);
    if (!match) continue;
    const timestamp = parseTimestamp(match[1]);
    if (timestamp != null && timestamp >= startedAt && timestamp <= completedAt) {
      selected.push(line);
    }
  }
  return selected.length > 0 ? selected.join('\n') : null;
}

export function validateRecoveryConfig(config) {
  const errors = [];
  if (config?.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (typeof config?.enabled !== 'boolean') errors.push('enabled must be boolean');
  if (config?.maxRunAttempts !== 2) {
    errors.push('maxRunAttempts must equal 2');
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
    for (const step of config.transientSteps) {
      if (!SAFE_TRANSIENT_STEPS.has(step)) {
        errors.push(`${step} is not in the code-owned recovery allowlist`);
      }
    }
    for (const forbidden of [
      'Static quality gate',
      'Run framework contract gate',
      'Run accessibility gate',
      'Run smoke suite',
      'Compare against canonical baseline',
      'Audit dependency graph',
      'Audit npm dependency graph at HIGH/CRITICAL severity',
      'Scan dependencies, configuration, and repository secrets',
      'Review dependency changes',
      'Analyze',
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
  return TRANSIENT_LOG_SIGNATURES.filter((signature) => signatureMatches(signature, text)).map(
    ({ id }) => id,
  );
}

export function matchingNonTransientSignatures(logs) {
  const text = String(logs || '');
  return NON_TRANSIENT_LOG_SIGNATURES.filter((signature) => signatureMatches(signature, text)).map(
    ({ id }) => id,
  );
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

  const stepLogs = extractStepLogWindow(logs, failedStep);
  if (stepLogs == null) {
    return {
      transient: false,
      reason: `failed step has no attributable timestamp-bounded log window: ${failedStep.name}`,
      signatures: [],
      failedStep: failedStep.name,
    };
  }

  const blockers = matchingNonTransientSignatures(stepLogs);
  if (blockers.length > 0) {
    return {
      transient: false,
      reason: `failed step contains deterministic or policy-blocking evidence: ${blockers.join(', ')}`,
      signatures: [],
      blockers,
      failedStep: failedStep.name,
    };
  }

  const signatures = matchingTransientSignatures(stepLogs);
  if (signatures.length === 0) {
    return {
      transient: false,
      reason: `allowlisted infrastructure step has no proven transient network/service signature in its own log window: ${failedStep.name}`,
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

  const gateJobs = (jobs || []).filter((job) => job.name === gateName);
  if (gateJobs.length !== 1 || gateJobs[0].conclusion !== 'failure') {
    return {
      rerunnable: false,
      reason: 'stable aggregate gate is missing, duplicated, or not a completed failure',
      failures: [],
    };
  }

  const leafJobs = (jobs || []).filter((job) => job.name !== gateName);
  const ambiguousLeafJobs = leafJobs.filter(
    (job) => job.conclusion !== 'failure' && !TERMINAL_NONBLOCKING_CONCLUSIONS.has(job.conclusion),
  );
  if (ambiguousLeafJobs.length > 0) {
    return {
      rerunnable: false,
      reason: `leaf job has ambiguous terminal state: ${ambiguousLeafJobs
        .map((job) => `${job.name}=${job.conclusion || 'unknown'}`)
        .join(', ')}`,
      failures: [],
    };
  }

  const failedLeafJobs = leafJobs.filter((job) => job.conclusion === 'failure');
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
  const protectedPaths = files
    .map((file) => file.filename)
    .filter((filename) => governanceConfig.manualReviewPaths.includes(filename));
  if (protectedPaths.length > 0) {
    reasons.push(`recovery is disabled for control-plane path(s): ${protectedPaths.join(', ')}`);
  }
  const ecosystem = classifyEcosystem(files, governanceConfig);
  if (ecosystem === 'unknown') {
    reasons.push('changed-file set does not map to one allowlisted dependency ecosystem');
  }
  return { eligible: reasons.length === 0, reasons: unique(reasons), ecosystem };
}

async function boundedPages(getPage, selector, maxPages) {
  const values = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await getPage(page, PAGE_SIZE);
    const pageValues = selector(response.data);
    if (!Array.isArray(pageValues)) throw new Error('paginated GitHub response is not an array');
    values.push(...pageValues);
    if (pageValues.length < PAGE_SIZE) return values;
  }
  throw new Error(`pagination safety limit reached after ${maxPages} page(s)`);
}

async function currentBaseSha(github, owner, repo, branch) {
  const response = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  return response.data.object.sha;
}

async function pullDetails(github, owner, repo, number) {
  const response = await github.rest.pulls.get({ owner, repo, pull_number: number });
  return response.data;
}

async function pullCommits(github, owner, repo, number) {
  const response = await github.rest.pulls.listCommits({
    owner,
    repo,
    pull_number: number,
    per_page: PAGE_SIZE,
  });
  if (!Array.isArray(response.data) || response.data.length > PAGE_SIZE) {
    throw new Error('pull request commit history is not safely bounded');
  }
  return response.data;
}

async function pullFiles(github, owner, repo, pull) {
  if (pull.changed_files > PAGE_SIZE) {
    throw new Error(`PR changes ${pull.changed_files} files; refusing oversized recovery input`);
  }
  const response = await github.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: pull.number,
    per_page: PAGE_SIZE,
  });
  return response.data;
}

async function qualificationRuns(github, owner, repo, pull, governanceConfig) {
  const runs = await boundedPages(
    (page, perPage) =>
      github.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        head_sha: pull.head.sha,
        event: 'pull_request',
        page,
        per_page: perPage,
      }),
    (data) => data.workflow_runs,
    governanceConfig.maxPaginationPages,
  );
  return governanceConfig.requiredWorkflows.map((requirement) => ({
    requirement,
    run: selectQualificationRun(runs, pull, requirement),
  }));
}

async function workflowJobs(github, owner, repo, runId, maxPages) {
  return boundedPages(
    (page, perPage) =>
      github.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: runId,
        filter: 'latest',
        page,
        per_page: perPage,
      }),
    (data) => data.jobs,
    maxPages,
  );
}

function decodeLogPayload(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data ?? '');
}

async function jobLogs(github, owner, repo, jobId) {
  const response = await github.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
    owner,
    repo,
    job_id: jobId,
  });
  return decodeLogPayload(response.data);
}

async function classifyRequirementFailure({
  github,
  owner,
  repo,
  requirement,
  run,
  recoveryConfig,
  maxPages,
}) {
  if (!run || run.status !== 'completed' || run.conclusion !== 'failure') {
    return {
      workflow: requirement.workflow,
      runId: run?.id || null,
      rerunnable: false,
      reason: 'required workflow is not a completed failure',
      failures: [],
    };
  }
  const jobs = await workflowJobs(github, owner, repo, run.id, maxPages);
  const failedLeafJobs = jobs.filter(
    (job) => job.conclusion === 'failure' && job.name !== requirement.gate,
  );
  const logsByJobId = {};
  for (const job of failedLeafJobs) {
    try {
      logsByJobId[job.id] = await jobLogs(github, owner, repo, job.id);
    } catch {
      logsByJobId[job.id] = '';
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

async function rerunFailedJobs(github, owner, repo, runId) {
  try {
    await github.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs', {
      owner,
      repo,
      run_id: runId,
    });
    return 'rerun-requested';
  } catch (error) {
    if (error?.status === 409) return 'already-running';
    throw error;
  }
}

async function recoverPull({
  github,
  owner,
  repo,
  number,
  governanceConfig,
  recoveryConfig,
  allowRerun,
}) {
  const pull = await pullDetails(github, owner, repo, number);
  if (
    pull.user?.login !== governanceConfig.botLogin ||
    pull.user?.id !== governanceConfig.botUserId
  ) {
    return { pr: number, skipped: true, reason: 'not canonical Dependabot' };
  }
  if (pull.state !== 'open') {
    return { pr: number, skipped: true, reason: `pull request state is ${pull.state}` };
  }

  const baseSha = await currentBaseSha(github, owner, repo, governanceConfig.baseBranch);
  const [commits, files] = await Promise.all([
    pullCommits(github, owner, repo, number),
    pullFiles(github, owner, repo, pull),
  ]);
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

  const qualifications = await qualificationRuns(github, owner, repo, pull, governanceConfig);
  const failures = [];
  for (const { requirement, run } of qualifications) {
    if (run?.status === 'completed' && run?.conclusion === 'failure') {
      failures.push(
        await classifyRequirementFailure({
          github,
          owner,
          repo,
          requirement,
          run,
          recoveryConfig,
          maxPages: governanceConfig.maxPaginationPages,
        }),
      );
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
    actions.push({
      workflow: failure.workflow,
      runId: failure.runId,
      state: await rerunFailedJobs(github, owner, repo, failure.runId),
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

async function resolvePullNumber({ github, context, owner, repo }) {
  if (context.eventName === 'pull_request_target' || context.eventName === 'pull_request') {
    return context.payload.pull_request?.number || null;
  }
  if (context.eventName === 'workflow_run') {
    const direct = context.payload.workflow_run?.pull_requests?.[0]?.number;
    if (direct) return direct;
    const branch = context.payload.workflow_run?.head_branch;
    if (!branch) return null;
    const response = await github.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:${branch}`,
      per_page: PAGE_SIZE,
    });
    return response.data.length === 1 ? response.data[0].number : null;
  }
  if (context.eventName === 'workflow_dispatch') {
    const value = context.payload.inputs?.['pr-number'];
    return value == null || value === '' ? null : positiveInteger(value, 'pr-number');
  }
  return null;
}

export async function runDependencyRecovery({
  github,
  context,
  core,
  allowRerun,
  governancePath = '.github/dependency-governance.json',
  recoveryPath = '.github/dependency-recovery.json',
}) {
  const governanceConfig = loadJson(governancePath);
  const governanceErrors = validateConfig(governanceConfig);
  if (governanceErrors.length > 0) {
    throw new Error(`Invalid dependency governance config:\n- ${governanceErrors.join('\n- ')}`);
  }
  const recoveryConfig = loadJson(recoveryPath);
  const recoveryErrors = validateRecoveryConfig(recoveryConfig);
  if (recoveryErrors.length > 0) {
    throw new Error(`Invalid dependency recovery config:\n- ${recoveryErrors.join('\n- ')}`);
  }

  const { owner, repo } = context.repo;
  if (context.eventName === 'schedule') {
    const pulls = await boundedPages(
      (page, perPage) =>
        github.rest.pulls.list({ owner, repo, state: 'open', page, per_page: perPage }),
      (data) => data,
      governanceConfig.maxPaginationPages,
    );
    const results = [];
    for (const pull of pulls) {
      if (
        pull.user?.login !== governanceConfig.botLogin ||
        pull.user?.id !== governanceConfig.botUserId
      ) {
        continue;
      }
      try {
        results.push(
          await recoverPull({
            github,
            owner,
            repo,
            number: pull.number,
            governanceConfig,
            recoveryConfig,
            allowRerun,
          }),
        );
      } catch (error) {
        results.push({ pr: pull.number, error: error.message });
      }
    }
    core.info(JSON.stringify({ recovery: results }, null, 2));
    if (results.some((item) => item.error)) {
      throw new Error('scheduled dependency recovery encountered one or more controller errors');
    }
    return results;
  }

  const number = await resolvePullNumber({ github, context, owner, repo });
  if (!number) {
    core.info(`No pull request resolved for ${context.eventName}; recovery has nothing to do.`);
    return null;
  }
  const result = await recoverPull({
    github,
    owner,
    repo,
    number,
    governanceConfig,
    recoveryConfig,
    allowRerun,
  });
  core.info(JSON.stringify({ recovery: result }, null, 2));
  return result;
}
