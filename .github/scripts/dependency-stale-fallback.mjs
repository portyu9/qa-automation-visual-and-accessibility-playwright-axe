import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

const SHA = /^[0-9a-f]{40}$/;
const MARKER = '<!-- dependency-stale-docker-recovery:v1:';
const INCIDENT = '<!-- dependency-stale-docker-incident:v1:';
const ACTIONS_MARKER = '<!-- dependency-stale-actions-recovery:v1:';
const ACTIONS_INCIDENT = '<!-- dependency-stale-actions-incident:v1:';
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
function incidentMarker(number, head, ecosystem = 'docker') {
  const prefix = ecosystem === 'github-actions' ? ACTIONS_INCIDENT : INCIDENT;
  return prefix + number + ':' + head + ' -->';
}
function validatedFilePath(path) {
  if (path !== 'Dockerfile' && !WORKFLOW_PATH.test(path)) fail('disallowed immutable recovery path');
  return path;
}

function fail(message) { throw new Error('Docker fallback: ' + message); }
function same(a, b) { return a === b && SHA.test(String(a || '')); }
function exactTime(value, now) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time <= now.getTime() ? time : null;
}
function sourceMarker(number, head, ecosystem = 'docker') {
  return (ecosystem === 'github-actions' ? ACTIONS_MARKER : MARKER) + number + ':' + head + ' -->';
}
function branchName(number, head, ecosystem = 'docker') {
  const prefix = ecosystem === 'github-actions' ? 'actions-pr-' : 'docker-pr-';
  return 'dependency-recovery/' + prefix + number + '-' + head.slice(0, 12);
}
function fullPath(branch) { return '/git/ref/heads/' + branch.split('/').map(encodeURIComponent).join('/'); }

export function recreateLease({ comments, number, head, config, now = new Date() }) {
  if (!Number.isSafeInteger(number) || number < 1 || !SHA.test(head) || !Number.isFinite(now.getTime())) fail('invalid lease subject or clock');
  const owned = (comments || []).filter((comment) =>
    comment.user?.login === config.ownerApprovalLogin
    && comment.user?.id === config.ownerApprovalUserId
    && comment.performed_via_github_app == null);
  const identify = (command) => owned.filter((item) =>
    String(item.body || '').split('\n').some((line) =>
      line.startsWith('<!-- dependency-owner-refresh:v1:' + head + ':')
      && new RegExp('^<!-- dependency-owner-refresh:v1:' + head + ':[0-9a-f]{40}:' + command + ' -->$').test(line)));
  const rebases = identify('rebase'), recreates = identify('recreate');
  if (rebases.length > 1 || recreates.length > 1) fail('ambiguous refresh history for immutable head');
  if (rebases.length !== 1 || recreates.length !== 1) return { state: 'waiting-native', reason: 'missing verified rebase or recreate' };
  const rebaseAt = exactTime(rebases[0].created_at, now);
  const recreateAt = exactTime(recreates[0].created_at, now);
  if (rebaseAt === null || recreateAt === null || recreateAt - rebaseAt < config.nativeRefreshEscalationMinutes * 60000) {
    fail('refresh history has invalid, future, or premature timestamps');
  }
  if (now.getTime() - recreateAt < config.nativeRefreshEscalationMinutes * 60000) {
    return { state: 'waiting-native', reason: 'recreate lease has not expired' };
  }
  return { state: 'expired', rebaseCommentId: rebases[0].id, recreateCommentId: recreates[0].id, recreateAt };
}

function blobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
}
async function readVerifiedFile(api, sha, path = 'Dockerfile') {
  if (!SHA.test(sha)) fail('noncanonical immutable file ref');
  const safe = validatedFilePath(path).split('/').map(encodeURIComponent).join('/');
  const file = await api.get('/contents/' + safe + '?ref=' + sha);
  if (file?.encoding !== 'base64' || !SHA.test(file?.sha || '') || typeof file.content !== 'string') fail('invalid GitHub contents object');
  const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (blobSha(text) !== file.sha) fail('content bytes do not match exact Git blob identity');
  return { text, sha: file.sha };
}
async function baseSha(api, branch) {
  const result = await api.get('/git/ref/heads/' + encodeURIComponent(branch));
  if (!SHA.test(result?.object?.sha || '')) fail('unverifiable accepted main');
  return result.object.sha;
}
async function maybeRef(api, branch) {
  try { return (await api.get(fullPath(branch)))?.object?.sha; }
  catch (error) {
    if (/\bfailed \(404\):/.test(String(error.message || ''))) return null;
    throw error;
  }
}
async function recoveryPull(api, branch) {
  const pulls = await api.paginate('/pulls?state=all&head=' + encodeURIComponent(api.owner + ':' + branch));
  if (pulls.length > 1) fail('multiple recovery PRs share the deterministic branch');
  return pulls[0] || null;
}
async function validateUnopenedBranch(api, base, revision, projected, filePath = 'Dockerfile') {
  if (!SHA.test(base) || !SHA.test(revision)) fail('branch publication refs are not immutable SHAs');
  const [commit, comparison, contents] = await Promise.all([
    api.get('/git/commits/' + revision),
    api.get('/compare/' + base + '...' + revision),
    readVerifiedFile(api, revision, filePath),
  ]);
  if (!commit?.parents?.some((p) => p.sha === base)
    || comparison?.status !== 'ahead' || !Number.isSafeInteger(comparison?.ahead_by) || comparison.ahead_by < 1
    || comparison?.files?.length !== 1 || comparison.files[0]?.filename !== filePath
    || comparison.files[0]?.status !== 'modified'
    || contents.text !== projected.content) {
    fail('preexisting branch is not an exact signed Dockerfile-only projection of accepted main');
  }
}
async function createRevision(api, parent, text, prior = null, filePath = 'Dockerfile') {
  const parentCommit = await api.get('/git/commits/' + parent);
  if (!SHA.test(parentCommit?.tree?.sha || '')) fail('accepted main tree is unavailable');
  const blob = await api.post('/git/blobs', { content: text, encoding: 'utf-8' });
  if (!same(blob?.sha, blobSha(text))) fail('published blob is not the proven Dockerfile bytes');
  const tree = await api.post('/git/trees', {
    base_tree: parentCommit.tree.sha,
    tree: [{ path: validatedFilePath(filePath), mode: '100644', type: 'blob', sha: blob.sha }],
  });
  if (!SHA.test(tree?.sha || '')) fail('invalid recovered tree');
  const commit = await api.post('/git/commits', {
    message: 'recovery: project verified signed dependency pin onto accepted main\n\nSource provenance is recorded in the recovery PR, not impersonated in this commit.',
    tree: tree.sha, parents: prior ? [prior, parent] : [parent],
  });
  if (!SHA.test(commit?.sha || '')) fail('invalid recovered commit');
  return commit.sha;
}

async function validateRecoveryBranch(api, branch, pr, number, head, projected, mainSha, config, ecosystem = 'docker', filePath = 'Dockerfile') {
  const marker = sourceMarker(number, head, ecosystem);
  if (!pr || !String(pr.body || '').includes(marker)
    || pr.head?.ref !== branch || pr.base?.ref !== config.baseBranch
    || pr.user?.login !== 'github-actions[bot]' || pr.user?.id !== 41898282) fail('recovery PR identity, author, or provenance marker mismatch');
  if (!SHA.test(pr.head?.sha || '')) fail('recovery PR head SHA missing');
  const commit = await api.get('/git/commits/' + pr.head.sha);
  if (!commit?.parents?.some((p) => p.sha === mainSha)) return { state: 'base-advanced' };
  const files = await api.paginate('/pulls/' + pr.number + '/files');
  if (files.length !== 1 || files[0]?.filename !== filePath || files[0]?.status !== 'modified') fail('recovery PR changed a non-Dockerfile path');
  const actual = await readVerifiedFile(api, pr.head.sha, filePath);
  if (actual.text !== projected.content) fail('recovery PR bytes differ from independently projected signed delta');
  return { state: 'current', head: pr.head.sha };
}

async function postMergeProof(api, pr, config, source, now, filePath = 'Dockerfile') {
  if (pr.merged !== true || !SHA.test(pr.merge_commit_sha || '') || !pr.merged_at) fail('recovery PR is not provably merged');
  const merged = await api.get('/git/commits/' + pr.merge_commit_sha);
  if (merged?.parents?.length !== 2 || !SHA.test(pr.head?.sha || '')
    || merged.parents[1]?.sha !== pr.head.sha || !SHA.test(merged.parents[0]?.sha || '')) {
    fail('recovery merge commit does not have the exact trusted PR head and accepted-main parents');
  }
  const [accepted, parent, comparison] = await Promise.all([
    readVerifiedFile(api, pr.merge_commit_sha, filePath),
    readVerifiedFile(api, merged.parents[0].sha, filePath),
    api.get('/compare/' + merged.parents[0].sha + '...' + pr.merge_commit_sha),
  ]);
  if (comparison?.files?.length !== 1 || comparison.files[0]?.filename !== filePath
    || comparison.files[0]?.status !== 'modified') fail('merged recovery changed an unrelated path');
  const projected = source.project(source.original, source.signed, parent.text);
  if (projected.state !== 'projected' || projected.content !== accepted.text) {
    fail('merged Dockerfile contains edits beyond the verified signed projection');
  }
  const runs = await api.paginate('/actions/runs?head_sha=' + pr.merge_commit_sha + '&event=workflow_dispatch', 'workflow_runs');
  const proof = [];
  for (const gate of config.requiredWorkflows) {
    const eligible = runs.filter((run) =>
      run.name === gate.workflow && run.path === '.github/workflows/' + gate.file
      && run.head_sha === pr.merge_commit_sha && run.event === 'workflow_dispatch'
      && exactTime(run.created_at, now) !== null
      && Date.parse(run.created_at) >= Date.parse(pr.merged_at))
      .sort((a, b) => b.id - a.id);
    const run = eligible[0];
    if (!run || run.status !== 'completed' || run.conclusion !== 'success') { proof.push({ gate: gate.gate, state: 'pending' }); continue; }
    const jobs = await api.paginate('/actions/runs/' + run.id + '/jobs?filter=latest', 'jobs');
    proof.push({ gate: gate.gate, state: jobs.some((job) =>
      job.name === gate.gate && job.status === 'completed' && job.conclusion === 'success') ? 'success' : 'pending' });
  }
  if (proof.some((item) => item.state !== 'success')) {
    if (now.getTime() - Date.parse(pr.merged_at) >= config.nativeRefreshEscalationMinutes * 4 * 60000) fail('post-merge exact-commit gates did not all succeed within deadline');
    return { state: 'merged-awaiting-verification', proof };
  }
  return { state: 'verified', proof };
}

export async function runStaleDockerFallback({ api, ownerApi, assessment, config, allowMerge, helpers, now = new Date() }) {
  const number = assessment.pull.number, head = assessment.pull.head?.sha;
  if (assessment.provenance.reasons.length !== 1
    || assessment.provenance.reasons[0] !== 'PR is not rebased directly on the current base branch head') return { state: 'not-stale-only' };
  await helpers.verifyOwnerIdentity(ownerApi, config);
  const comments = await ownerApi.paginate('/issues/' + number + '/comments');
  const lease = recreateLease({ comments, number, head, config, now });
  if (lease.state !== 'expired') return lease;
  const current = await helpers.assessPull(api, number, config, { includeQualification: false });
  const ecosystem = current.ecosystem;
  const filePath = current.files?.[0]?.filename;
  const actionsPolicy = config.ecosystems?.['github-actions'];
  const isDocker = ecosystem === 'docker' && filePath === 'Dockerfile';
  const isActions = ecosystem === 'github-actions'
    && WORKFLOW_PATH.test(filePath || '')
    && typeof actionsPolicy?.workflowPrefix === 'string'
    && filePath.startsWith(actionsPolicy.workflowPrefix)
    && actionsPolicy.extensions?.some((extension) => filePath.endsWith(extension))
    && !config.manualReviewPaths.includes(filePath);
  if (current.pull.state !== 'open' || current.pull.head?.sha !== head
      || current.provenance.reasons.join('|') !== 'PR is not rebased directly on the current base branch head'
      || !current.metadataAssessment.eligible
      || current.files.length !== 1 || current.files[0].status !== 'modified'
      || (!isDocker && !isActions)) {
    fail('source changed, is untrusted, or is not one eligible signed dependency-only pin');
  }
  const sourceBase = current.provenance.commit?.parents?.[0]?.sha;
  if (!SHA.test(sourceBase || '') || !SHA.test(head)) fail('unverifiable signed source ancestry');
  const [original, signed, live] = await Promise.all([
    readVerifiedFile(api, sourceBase, filePath), readVerifiedFile(api, head, filePath),
    readVerifiedFile(api, current.baseSha, filePath),
  ]);
  if (current.files[0].sha !== signed.sha) fail('signed PR diff and immutable blob identity disagree');
  const project = isDocker
    ? (a, b, c) => helpers.projectSignedDockerDelta({
      sourceBaseText: a, signedHeadText: b, currentMainText: c,
      signedMetadata: current.metadataAssessment.metadata,
      allowedImages: config.ecosystems.docker.allowedImages,
    })
    : (a, b, c) => helpers.projectSignedActionsDelta({
      sourceBaseText: a, signedHeadText: b, currentMainText: c,
      signedMetadata: current.metadataAssessment.metadata,
      workflowPath: filePath,
      manualReviewPaths: config.manualReviewPaths,
    });
  const projected = project(original.text, signed.text, live.text);
  const marker = sourceMarker(number, head, ecosystem);
  const name = branchName(number, head, ecosystem);
  let revision = await maybeRef(api, name);
  let pr = await recoveryPull(api, name);
  if (pr) {
    if (!String(pr.body || '').includes(marker)
      || pr.head?.ref !== name || pr.base?.ref !== config.baseBranch
      || pr.user?.login !== 'github-actions[bot]' || pr.user?.id !== 41898282) {
      fail('published recovery PR has unexpected actor, source, head, or base identity');
    }
    const paths = await api.paginate('/pulls/' + pr.number + '/files');
    if (paths.length !== 1 || paths[0]?.filename !== filePath
      || paths[0]?.status !== 'modified') fail('published recovery PR changed untrusted paths');
  }
  // A recovered merge has made the source delta "already accepted", but it
  // MUST NOT shortcut exact-merge post-merge attestation and close the source.
  if (projected.state === 'already-accepted' && pr?.merged === true) {
    const result = await postMergeProof(api, pr, config, { original: original.text, signed: signed.text, project }, now, filePath);
    if (result.state !== 'verified') return { ...result, number: pr.number };
    const latest = await api.get('/pulls/' + number);
    if (latest.state !== 'open' || latest.head?.sha !== head) return { state: 'source-advanced-retry' };
    await api.post('/issues/' + number + '/comments', { body: marker + '\nRecovery PR #' + pr.number + ' merged at ' + pr.merge_commit_sha + '; exact-commit post-merge gates verified. Signed source blob: ' + signed.sha });
    await api.patch('/pulls/' + number, { state: 'closed' });
    await resolveRecoveryIncident(api, number, head, 'recovery PR #' + pr.number + ', merge ' + pr.merge_commit_sha, ecosystem);
    return { state: 'verified', number: pr.number, mergeCommit: pr.merge_commit_sha };
  }
  if (projected.state === 'already-accepted') {
    if (pr && pr.state === 'open') {
      await api.post('/issues/' + pr.number + '/comments', { body: marker + '\nAlready accepted on main by independent development; recovery PR is superseded.' });
      await api.patch('/pulls/' + pr.number, { state: 'closed' });
    }
    const latest = await api.get('/pulls/' + number);
    if (latest.state !== 'open' || latest.head?.sha !== head) return { state: 'source-advanced-retry' };
    await api.post('/issues/' + number + '/comments', { body: marker + '\nAccepted main already contains this exact verified signed Docker update; no duplicate PR.' });
    await api.patch('/pulls/' + number, { state: 'closed' });
    await resolveRecoveryIncident(api, number, head, 'main ' + current.baseSha + ', signed dependency blob ' + signed.sha, ecosystem);
    return { state: 'already-accepted', sourceBlob: signed.sha, mainSha: current.baseSha };
  }
  if (!revision && pr && pr.merged !== true) fail('open recovery PR lost its immutable source branch');
  if (!revision) {
    if ((await baseSha(api, config.baseBranch)) !== current.baseSha) return { state: 'main-advanced-retry' };
    revision = await createRevision(api, current.baseSha, projected.content, null, filePath);
    // Re-check both source and accepted main before publishing the branch.
    if ((await baseSha(api, config.baseBranch)) !== current.baseSha
      || (await api.get('/pulls/' + number)).head?.sha !== head) return { state: 'main-or-source-advanced-retry' };
    await api.post('/git/refs', { ref: 'refs/heads/' + name, sha: revision });
  }
  if (!pr) {
    const sourceLive = await api.get('/pulls/' + number);
    if (sourceLive.state !== 'open' || sourceLive.head?.sha !== head) {
      return { state: 'dependabot-progressed-retry' };
    }
    // Resume interrupted branch publication only when every tree byte and
    // the complete net branch diff are proven against latest accepted main.
    // This also refuses an attacker-precreated deterministic branch name.
    if ((await baseSha(api, config.baseBranch)) !== current.baseSha) {
      return { state: 'main-advanced-retry' };
    }
    if (revision && (await api.get('/git/commits/' + revision))?.parents?.every((p) => p.sha !== current.baseSha)) {
      // Validate the abandoned branch against its historical accepted parent
      // BEFORE bringing a trusted projection forward on current main.
      const prior = await api.get('/git/commits/' + revision);
      if (!Array.isArray(prior.parents) || prior.parents.length !== 1 || !SHA.test(prior.parents[0].sha)) fail('ambiguous orphan recovery lineage');
      const ancestry = await api.get('/compare/' + prior.parents[0].sha + '...' + current.baseSha);
      if (!['ahead', 'identical'].includes(ancestry?.status)) fail('abandoned recovery parent is not an ancestor of accepted main');
      const priorMain = await readVerifiedFile(api, prior.parents[0].sha, filePath);
      const priorProjection = project(original.text, signed.text, priorMain.text);
      if (priorProjection.state !== 'projected') fail('abandoned branch no longer represents a unique signed delta');
      await validateUnopenedBranch(api, prior.parents[0].sha, revision, priorProjection, filePath);
      const next = await createRevision(api, current.baseSha, projected.content, revision, filePath);
      await api.patch('/git/refs/heads/' + name.split('/').map(encodeURIComponent).join('/'), { sha: next, force: false });
      revision = next;
    }
    await validateUnopenedBranch(api, current.baseSha, revision, projected, filePath);
    pr = await api.post('/pulls', {
      title: 'recovery(' + ecosystem + '): independently qualify signed Dependabot PR #' + number,
      head: name, base: config.baseBranch, draft: false,
      body: [
        marker, 'Independent recovery from a verified, immutable, GitHub-signed Dependabot source.',
        'Source PR: #' + number, 'Signed source commit: ' + head,
        'Signed source parent: ' + sourceBase, 'Signed dependency blob: ' + signed.sha,
        'Verified recovery file: ' + filePath,
        'Accepted main at initial projection: ' + current.baseSha,
        'Recovery commit is controller-authored; it is NOT a Dependabot-signed commit.',
        'Required: fresh exact-head ' + config.requiredWorkflows.map((gate) => gate.gate).join(', ')
          + ', owner review and accepted-main verification.',
      ].join('\n\n'),
    });
    if (!Number.isSafeInteger(pr?.number)) fail('recovery PR publication has no verifiable number');
    // GITHUB_TOKEN-authored PRs do not trigger pull_request workflows. A distinct
    // owner-authenticated reopen emits the required PR event without rewriting history.
    await ownerApi.patch('/pulls/' + pr.number, { state: 'closed' });
    await ownerApi.patch('/pulls/' + pr.number, { state: 'open' });
    return { state: 'recovery-pr-created', number: pr.number, head: revision };
  }
  pr = await api.get('/pulls/' + pr.number);
  if (pr.state === 'closed' && pr.merged !== true) fail('recovery PR was closed without a verified merge');
  if (pr.merged === true) fail('merged recovery PR does not contain verified signed source update');
  if (pr.state !== 'open') fail('unexpected recovery PR state');
  if ((await baseSha(api, config.baseBranch)) !== current.baseSha) return { state: 'main-advanced-retry' };
  let validity = await validateRecoveryBranch(api, name, pr, number, head, projected, current.baseSha, config, ecosystem, filePath);
  if (validity.state === 'base-advanced') {
    const next = await createRevision(api, current.baseSha, projected.content, pr.head.sha, filePath);
    await api.patch('/git/refs/heads/' + name.split('/').map(encodeURIComponent).join('/'), { sha: next, force: false });
    return { state: 'recovery-rebased', number: pr.number, head: next };
  }
  const quality = await helpers.qualificationForHead(api, pr, config);
  if (!quality.allSuccess) {
    if (now.getTime() - lease.recreateAt > config.nativeRefreshEscalationMinutes * 8 * 60000) fail('recovery PR exact-head qualification deadline expired');
    return { state: 'qualifying', number: pr.number, quality };
  }
  if (!allowMerge) return { state: 'qualified-awaiting-merge-permission', number: pr.number };
  await helpers.verifyOwnerIdentity(ownerApi, config);
  const approved = async () => (await ownerApi.paginate('/pulls/' + pr.number + '/reviews')).some((review) =>
    review.user?.login === config.ownerApprovalLogin && review.user?.id === config.ownerApprovalUserId
    && review.state === 'APPROVED' && review.commit_id === pr.head.sha);
  if (!(await approved())) {
    await ownerApi.post('/pulls/' + pr.number + '/reviews', {
      event: 'APPROVE', commit_id: pr.head.sha,
      body: 'Owner approval of independently recovered signed ' + ecosystem + ' pin. Signed source ' + head
        + '; exact recovery head ' + pr.head.sha + '; all configured exact-head gates passed.',
    });
  }
  if (!(await approved())) fail('exact-head owner approval was not observed');
  const [fresh, liveSource, latestBase] = await Promise.all([
    api.get('/pulls/' + pr.number),
    api.get('/pulls/' + number),
    baseSha(api, config.baseBranch),
  ]);
  if (fresh.head?.sha !== pr.head.sha || fresh.state !== 'open'
    || liveSource.state !== 'open' || liveSource.head?.sha !== head
    || latestBase !== current.baseSha) return { state: 'race-retry' };
  validity = await validateRecoveryBranch(api, name, fresh, number, head, projected, current.baseSha, config, ecosystem, filePath);
  if (validity.state !== 'current') return { state: 'race-retry' };
  const merged = await api.put('/pulls/' + pr.number + '/merge', {
    merge_method: config.mergeMethod, sha: pr.head.sha,
    commit_title: pr.title,
    commit_message: 'Independent signed ' + ecosystem + ' pin recovery, exact-head qualified. Source Dependabot PR #' + number + ' at ' + head,
  });
  if (merged?.merged !== true || !SHA.test(merged.sha || '')) fail('exact-head recovery merge was not confirmed');
  for (const gate of config.requiredWorkflows) {
    await api.post('/actions/workflows/' + encodeURIComponent(gate.file) + '/dispatches', { ref: config.baseBranch });
  }
  return { state: 'merged-awaiting-verification', number: pr.number, mergeCommit: merged.sha };
}

async function resolveRecoveryIncident(api, number, head, proof, ecosystem = 'docker') {
  const marker = incidentMarker(number, head, ecosystem);
  const issues = await api.paginate('/issues?state=open');
  const issue = issues.find((item) => !item.pull_request && String(item.body || '').includes(marker));
  if (!issue) return;
  await api.post('/issues/' + issue.number + '/comments', {
    body: 'Autonomous incident resolved by verified signed-source acceptance: ' + proof,
  });
  await api.patch('/issues/' + issue.number, { state: 'closed' });
}

export async function reportStaleRecoveryIncident(api, number, head, error, ecosystem = 'docker') {
  const marker = incidentMarker(number, head, ecosystem);
  const issues = await api.paginate('/issues?state=open');
  let issue = issues.find((item) => !item.pull_request && String(item.body || '').includes(marker));
  if (!issue) {
    issue = await api.post('/issues', {
      title: 'Dependency recovery blocked (' + ecosystem + '): signed PR #' + number,
      body: marker + '\n\nAutonomous ' + ecosystem + ' fallback failed closed. Governance must remain failed until independently resolved.\n\nSource: #' + number + ' at ' + head + '\n\nReason: ' + String(error.message || error).slice(0, 2000),
    });
  }
  if (!Number.isSafeInteger(issue?.number)) fail('could not record the required tracked recovery incident');
  return { incident: issue.number, reason: String(error.message || error) };
}
