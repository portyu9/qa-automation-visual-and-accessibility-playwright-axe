import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { recreateLease, runStaleDockerFallback, reportStaleRecoveryIncident } from './dependency-stale-fallback.mjs';
import { projectSignedDockerDelta } from './dependency-governance.mjs';

const config = JSON.parse(readFileSync('.github/dependency-governance.json', 'utf8'));
const head = 'b'.repeat(40), originalSha = 'a'.repeat(40), mainSha = 'd'.repeat(40);
const now = new Date('2026-11-17T04:00:00Z');
const before = 'FROM node:24.22.2-trixie-slim@sha256:' + 'a'.repeat(64) + '\n\nARG SECURITY_PIN=trusted\n';
const after = 'FROM node:24.22.3-trixie-slim@sha256:' + 'b'.repeat(64) + '\n\nARG SECURITY_PIN=trusted\n';
const advanced = before.replace('ARG SECURITY_PIN=trusted', 'ARG SECURITY_PIN=accepted-change');
const metadata = [{ name: 'node', version: '24.22.3-trixie-slim', updateType: 'version-update:semver-patch' }];
const sha = (s) => {
  const data = Buffer.from(s);
  return createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex');
};
const owner = { login: config.ownerApprovalLogin, id: config.ownerApprovalUserId };
const command = (command, base = mainSha, created_at = command === 'rebase' ? '2026-11-17T02:00:00Z' : '2026-11-17T02:40:00Z') => ({
  id: command === 'rebase' ? 11 : 12, created_at, user: owner,
  body: '@dependabot ' + command + '\n\n<!-- dependency-owner-refresh:v1:' + head + ':' + base + ':' + command + ' -->',
});
const comments = [command('rebase', 'e'.repeat(40)), command('recreate')];

test('exact immutable head controls both leases across independently advancing main', () => {
  assert.equal(recreateLease({ comments, number: 41, head, config, now }).state, 'expired');
  assert.equal(recreateLease({ comments, number: 41, head, config, now: new Date('2026-11-17T03:09:59Z') }).state, 'waiting-native');
  assert.equal(recreateLease({ comments: [command('rebase')], number: 41, head, config, now }).state, 'waiting-native');
  assert.throws(() => recreateLease({ comments: [...comments, command('recreate')], number: 41, head, config, now }), /ambiguous/);
});

test('ACK does not count as a regenerated signed head; identity and timestamps must be genuine', () => {
  const ack = comments.map((c) => ({ ...c, reactions: { '+1': 1 } }));
  assert.equal(recreateLease({ comments: ack, number: 41, head, config, now }).state, 'expired');
  assert.equal(recreateLease({ comments: comments.map((c) => ({ ...c, user: { login: 'attacker', id: 17 } })), number: 41, head, config, now }).state, 'waiting-native');
  const future = [...comments.slice(0, 1), { ...comments[1], created_at: '2100-01-01T00:00:00Z' }];
  assert.throws(() => recreateLease({ comments: future, number: 41, head, config, now }), /invalid/);
  assert.throws(() => recreateLease({ comments: [command('rebase', mainSha, '2026-11-17T02:20:00Z'), command('recreate', mainSha, '2026-11-17T02:21:00Z')], number: 41, head, config, now }), /premature/);
  assert.equal(recreateLease({ comments, number: 41, head: 'f'.repeat(40), config, now }).state, 'waiting-native');
});

function fixture({ mainText = advanced, sourceText = after, assessmentReason = 'PR is not rebased directly on the current base branch head', files = null } = {}) {
  const source = {
    number: 41, state: 'open',
    head: { sha: head, ref: 'dependabot/docker/routine' },
    base: { ref: 'main' },
  };
  const assessment = {
    pull: source, baseSha: mainSha,
    provenance: { eligible: false, reasons: [assessmentReason], commit: { parents: [{ sha: originalSha }] } },
    metadataAssessment: { eligible: true, metadata },
    ecosystem: 'docker',
    files: files || [{ filename: 'Dockerfile', status: 'modified', sha: sha(sourceText) }],
  };
  const filesByRef = new Map([[originalSha, before], [head, sourceText], [mainSha, mainText]]);
  const state = { refs: new Map(), prs: [], comments: [...comments], ownerPatches: [], apiPosts: [], reviews: [], merge: null, status: 'missing', main: mainSha, now };
  const recoveryBranch = 'dependency-recovery/docker-pr-41-' + head.slice(0, 12);
  const api = {
    owner: 'o',
    root: 'https://api.github.com/repos/o/r',
    async get(path) {
      if (path === '/pulls/41') return source;
      if (path.startsWith('/compare/')) return {
        status: 'ahead', ahead_by: 1,
        files: [{ filename: 'Dockerfile', status: 'modified' }],
      };
      if (path === '/git/ref/heads/main') return { object: { sha: state.main } };
      if (path.startsWith('/git/ref/heads/')) {
        const ref = decodeURIComponent(path.slice('/git/ref/heads/'.length));
        if (!state.refs.has(ref)) throw new Error('GitHub API GET failed (404): Not Found');
        return { object: { sha: state.refs.get(ref) } };
      }
      if (path.startsWith('/contents/Dockerfile?ref=')) {
        const value = filesByRef.get(path.split('ref=')[1]);
        if (value === undefined) throw new Error('fixture unknown blob ' + path);
        return { sha: sha(value), encoding: 'base64', content: Buffer.from(value).toString('base64') };
      }
      if (path.startsWith('/git/commits/')) {
        const ref = path.split('/').at(-1);
        return { tree: { sha: 'e'.repeat(40) }, parents: state.parents?.get(ref) || [] };
      }
      if (path.startsWith('/pulls/')) return state.prs.find((pr) => pr.number === Number(path.split('/')[2]));
      throw new Error('fixture GET ' + path);
    },
    async paginate(path) {
      if (path.startsWith('/pulls?')) return state.prs;
      if (path.startsWith('/pulls/') && path.endsWith('/files')) return [{ filename: 'Dockerfile', status: 'modified' }];
      if (path.startsWith('/actions/runs?')) return state.status === 'verified' ? config.requiredWorkflows.map((g, i) => ({
        id: i + 1, name: g.workflow, path: '.github/workflows/' + g.file, head_sha: state.merge,
        event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
        created_at: '2026-11-17T03:10:00Z',
      })) : [];
      if (path.startsWith('/actions/runs/') && path.includes('/jobs')) {
        const n = Number(path.split('/')[3]);
        return [{ name: config.requiredWorkflows[n - 1].gate, status: 'completed', conclusion: 'success' }];
      }
      if (path.includes('/reviews')) return state.reviews;
      if (path === '/issues?state=open') return (state.issues || []).filter((issue) => issue.state !== 'closed');
      throw new Error('fixture paginate ' + path);
    },
    async post(path, body) {
      state.apiPosts.push({ path, body });
      if (path === '/git/blobs') { state.blobText = body.content; return { sha: sha(body.content) }; }
      if (path === '/git/trees') return { sha: 'e'.repeat(40) };
      if (path === '/git/commits') {
        const revision = state.parents?.size ? '8'.repeat(40) : 'c'.repeat(40);
        if (!state.parents) state.parents = new Map();
        state.parents.set(revision, body.parents.map((s) => ({ sha: s })));
        filesByRef.set(revision, state.blobText);
        return { sha: revision };
      }
      if (path === '/git/refs') { state.refs.set(recoveryBranch, body.sha); return { ref: body.ref }; }
      if (path === '/pulls') {
        const pr = {
          number: 73, state: 'open', merged: false, head: { ref: recoveryBranch, sha: state.refs.get(recoveryBranch) },
          base: { ref: 'main' }, user: { login: 'github-actions[bot]', id: 41898282 }, body: body.body,
          title: body.title,
        };
        state.prs.push(pr); return pr;
      }
      if (path === '/issues') { const issue = { number: 101, body: body.body }; state.issues = [issue]; return issue; }
      return {};
    },
    async patch(path, body) {
      if (path.startsWith('/git/refs/')) {
        state.refs.set(recoveryBranch, body.sha);
        if (state.prs[0]) state.prs[0].head.sha = body.sha;
        return {};
      }
      if (path.startsWith('/pulls/')) { const pr = path === '/pulls/41' ? source : state.prs[0]; pr.state = body.state; return pr; }
      if (path.startsWith('/issues/')) { const issue = state.issues?.find((i) => String(i.number) === path.split('/')[2]); if (!issue) throw Error('missing incident'); issue.state = body.state; return issue; }
      throw new Error('fixture patch ' + path);
    },
    async put(path, body) {
      if (!path.endsWith('/merge')) throw new Error('unexpected mutation');
      const pr = state.prs[0]; pr.merged = true; pr.state = 'closed';
      pr.merge_commit_sha = '9'.repeat(40); pr.merged_at = '2026-11-17T03:00:00Z';
      state.parents.set(pr.merge_commit_sha, [{ sha: state.main }, { sha: pr.head.sha }]);
      state.merge = pr.merge_commit_sha;
      state.main = pr.merge_commit_sha;
      filesByRef.set(pr.merge_commit_sha, state.blobText);
      return { merged: true, sha: pr.merge_commit_sha };
    },
  };
  const ownerApi = {
    async paginate(path) {
      if (path.includes('/reviews')) return state.reviews;
      if (path.includes('/comments')) return state.comments;
      throw new Error('owner paginate ' + path);
    },
    async patch(path, body) { state.ownerPatches.push({ path, body }); state.prs[0].state = body.state; return state.prs[0]; },
    async post(path, body) {
      if (path.includes('/reviews')) state.reviews.push({ user: owner, state: 'APPROVED', commit_id: body.commit_id });
      if (path.includes('/comments')) state.comments.push({ body: body.body, user: owner });
      return {};
    },
  };
  const helpers = {
    verifyOwnerIdentity: async () => {},
    assessPull: async () => ({ ...assessment, baseSha: state.main }),
    projectSignedDockerDelta,
    qualificationForHead: async () => ({ allSuccess: state.status === 'passed', qualifications: [] }),
  };
  return { api, ownerApi, assessment, config, helpers, now, state, filesByRef, source };
}
const run = (fixture, overrides = {}) => runStaleDockerFallback({ ...fixture, allowMerge: true, ...overrides });

test('no-op accepted signed source closes obsolete bot PR without creating a branch', async () => {
  const f = fixture({ mainText: after });
  const result = await run(f);
  assert.equal(result.state, 'already-accepted');
  assert.equal(f.source.state, 'closed');
  assert.equal(f.state.refs.size, 0);
});
test('publisher is separate actor and triggers PR qualification via owner-authenticated reopen', async () => {
  const f = fixture();
  const result = await run(f);
  assert.equal(result.state, 'recovery-pr-created');
  assert.equal(result.number, 73);
  assert.equal(f.state.prs[0].user.login, 'github-actions[bot]');
  assert.deepEqual(f.state.ownerPatches.map((p) => p.body.state), ['closed', 'open']);
  assert.deepEqual(f.state.prs[0].state, 'open');
  assert.equal(f.state.blobText.includes('accepted-change'), true, 'preserves unrelated accepted changes');
  const resuming = await run(f);
  assert.equal(resuming.state, 'qualifying');
  assert.equal(f.state.prs.length, 1, 'interrupted or repeated scheduled wakes do not duplicate recovery PRs');
  assert.equal(f.state.refs.size, 1);
});
test('publisher fails closed on incorrect signed blob, non-Docker changes, and same-image conflict', async () => {
  const wrong = fixture({ files: [{ filename: 'Dockerfile', status: 'modified', sha: 'f'.repeat(40) }] });
  await assert.rejects(() => run(wrong), /blob identity/);
  const extra = fixture({ files: [{ filename: 'package.json', status: 'modified', sha: sha(after) }] });
  await assert.rejects(() => run(extra), /not a single Dockerfile-only/);
  const conflict = fixture({ mainText: before.replace('24.22.2', '24.22.4') });
  await assert.rejects(() => run(conflict), /conflicts/);
  const unsigned = fixture({ assessmentReason: 'signature invalid' });
  assert.equal((await run(unsigned)).state, 'not-stale-only');
});
test('fresh PR only merges after all exact-head gates and owner approval; postmerge remains unverified', async () => {
  const f = fixture();
  await run(f);
  f.state.status = 'passed';
  const merged = await run(f);
  assert.equal(merged.state, 'merged-awaiting-verification');
  assert.equal(f.state.reviews.length, 1);
  assert.equal(f.state.apiPosts.filter((p) => p.path.endsWith('/dispatches')).length, config.requiredWorkflows.length);
  const pending = await run(f);
  assert.equal(pending.state, 'merged-awaiting-verification');
  assert.equal(f.source.state, 'open', 'source is NOT closed before post-merge proof');
  f.state.status = 'verified';
  const verified = await run(f);
  assert.equal(verified.state, 'verified');
  assert.equal(f.source.state, 'closed');
});
test('interrupted branch creation resumes only from exact verified Docker-only tree', async () => {
  const f = fixture();
  await run(f);
  const recoveryBranch = [...f.state.refs.keys()][0];
  f.state.prs.splice(0); // interruption after ref publication, before PR API readback
  const resumed = await run(f);
  assert.equal(resumed.state, 'recovery-pr-created');
  assert.equal(f.state.refs.size, 1);
  assert.equal(f.state.prs.length, 1);
  const tampered = fixture();
  await run(tampered);
  const revision = tampered.state.refs.values().next().value;
  tampered.state.prs.splice(0);
  tampered.filesByRef.set(revision, before);
  await assert.rejects(() => run(tampered), /preexisting branch is not an exact signed Dockerfile-only/);
});

test('main advancing after an orphaned branch safely reprojects, preserves accepted pins, and publishes once', async () => {
  const f = fixture();
  await run(f);
  const old = f.state.refs.values().next().value;
  f.state.prs.splice(0);
  f.state.main = 'f'.repeat(40);
  const newer = advanced.replace('accepted-change', 'newly-accepted-pin');
  f.filesByRef.set(f.state.main, newer);
  const outcome = await run(f);
  assert.equal(outcome.state, 'recovery-pr-created');
  assert.equal(f.state.prs.length, 1);
  assert.notEqual(f.state.refs.values().next().value, old);
  assert.match(f.state.blobText, /newly-accepted-pin/);
});

test('main advancing during an open recovery PR reprojects without force-pushing or merging stale checks', async () => {
  const f = fixture();
  await run(f);
  f.state.main = 'f'.repeat(40);
  const newer = advanced.replace('accepted-change', 'newly-accepted-pin');
  f.filesByRef.set(f.state.main, newer);
  const beforeHead = f.state.prs[0].head.sha;
  const result = await run(f);
  assert.equal(result.state, 'recovery-rebased');
  assert.notEqual(f.state.prs[0].head.sha, beforeHead);
  assert.match(f.state.blobText, /newly-accepted-pin/);
  assert.equal(f.state.reviews.length, 0, 'old checks/approval never authorize the new commit');
});

test('recovery merge attestation rejects unrelated files and forged ancestry even with green gates', async () => {
  const wrongActor = fixture();
  await run(wrongActor);
  wrongActor.state.prs[0].user.id = 13;
  await assert.rejects(() => run(wrongActor), /unexpected actor/);
  const wrongAncestry = fixture();
  await run(wrongAncestry);
  wrongAncestry.state.status = 'passed';
  await run(wrongAncestry);
  wrongAncestry.state.parents.set(wrongAncestry.state.merge, [{ sha: wrongAncestry.state.main }]);
  await assert.rejects(() => run(wrongAncestry), /accepted-main parents/);
  const wrongPatch = fixture();
  await run(wrongPatch);
  wrongPatch.state.status = 'passed';
  await run(wrongPatch);
  wrongPatch.filesByRef.set(wrongPatch.state.merge, after.replace('ARG SECURITY_PIN=trusted', 'ARG SECURITY_PIN=malicious'));
  await assert.rejects(() => run(wrongPatch), /beyond the verified signed projection/);
});

test('verified acceptance autonomously closes an existing incident with an audit comment', async () => {
  const f = fixture({ mainText: after });
  await reportStaleRecoveryIncident(f.api, 41, head, new Error('injected stalled provider'));
  assert.equal(f.state.issues[0].state, undefined);
  const result = await run(f);
  assert.equal(result.state, 'already-accepted');
  assert.equal(f.state.issues[0].state, 'closed');
  assert.equal(f.state.apiPosts.some((item) => item.path === '/issues/101/comments'
    && item.body.body.includes('verified signed-source acceptance')), true);
});

test('blocked incident is idempotently tracked and never treated as a green status', async () => {
  const f = fixture();
  const first = await reportStaleRecoveryIncident(f.api, 41, head, new Error('injected provider failure'));
  assert.equal(first.incident, 101);
  const second = await reportStaleRecoveryIncident(f.api, 41, head, new Error('injected provider failure'));
  assert.equal(second.incident, 101);
});
