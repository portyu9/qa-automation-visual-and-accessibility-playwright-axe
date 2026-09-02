#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_CONFIG_PATH = '.github/dependency-governance.json';
const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const PAGE_SIZE = 100;

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

export function jsonEqual(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

export function parseSemverLike(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (/[-+][0-9A-Za-z]/.test(value.replace(/^[~^<>=\s]*/, ''))) return null;
  const match = value.match(/^[~^<>=\s]*v?(\d+)\.(\d+)\.(\d+)(?:\s*)$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw: value };
}

export function compareSemver(oldVersion, newVersion) {
  const oldV = typeof oldVersion === 'string' ? parseSemverLike(oldVersion) : oldVersion;
  const newV = typeof newVersion === 'string' ? parseSemverLike(newVersion) : newVersion;
  if (!oldV || !newV) return { risk: 'unknown', reason: 'non-semver or prerelease version' };
  const tupleOld = [oldV.major, oldV.minor, oldV.patch];
  const tupleNew = [newV.major, newV.minor, newV.patch];
  for (let i = 0; i < 3; i += 1) {
    if (tupleNew[i] < tupleOld[i]) return { risk: 'downgrade', reason: 'dependency downgrade' };
    if (tupleNew[i] > tupleOld[i]) break;
  }
  if (oldV.major !== newV.major) return { risk: 'major', reason: 'semver major transition' };
  if (oldV.major === 0 && oldV.minor !== newV.minor) {
    return { risk: 'major-risk', reason: '0.x minor transition treated as breaking-risk' };
  }
  if (oldV.minor !== newV.minor) return { risk: 'minor', reason: 'semver minor transition' };
  if (oldV.patch !== newV.patch) return { risk: 'patch', reason: 'semver patch transition' };
  return { risk: 'same', reason: 'same semantic version' };
}

export function parseDependabotMetadata(message) {
  const result = [];
  const lines = String(message || '').split(/\r?\n/);
  let current = null;
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === 'updated-dependencies:') {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (line.trim() === '...') break;
    let match = line.match(/^\s*-\s+dependency-name:\s*(.+?)\s*$/);
    if (match) {
      if (current) result.push(current);
      current = { name: unquote(match[1]) };
      continue;
    }
    match = line.match(/^\s+dependency-version:\s*(.+?)\s*$/);
    if (match && current) current.version = unquote(match[1]);
    match = line.match(/^\s+dependency-type:\s*(.+?)\s*$/);
    if (match && current) current.dependencyType = unquote(match[1]);
    match = line.match(/^\s+update-type:\s*(.+?)\s*$/);
    if (match && current) current.updateType = unquote(match[1]);
  }
  if (current) result.push(current);
  return result;
}

function unquote(value) {
  const text = String(value).trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

export function classifyEcosystem(files, config) {
  const names = files.map((file) => (typeof file === 'string' ? file : file.filename));
  const npmFiles = new Set(config.ecosystems.npm.files);
  if (names.length > 0 && names.every((name) => npmFiles.has(name))) return 'npm';
  const dockerFiles = new Set(config.ecosystems.docker.files);
  if (names.length > 0 && names.every((name) => dockerFiles.has(name))) return 'docker';
  const { workflowPrefix, extensions } = config.ecosystems['github-actions'];
  if (
    names.length > 0 &&
    names.every(
      (name) => name.startsWith(workflowPrefix) && extensions.some((ext) => name.endsWith(ext)),
    )
  ) {
    return 'github-actions';
  }
  return 'unknown';
}

function stripDependencySections(pkg) {
  const clone = JSON.parse(JSON.stringify(pkg));
  for (const section of DEP_SECTIONS) delete clone[section];
  return clone;
}

function directDependencyMap(pkg) {
  const result = new Map();
  for (const section of DEP_SECTIONS) {
    for (const [name, spec] of Object.entries(pkg?.[section] || {})) {
      result.set(`${section}:${name}`, { section, name, spec });
    }
  }
  return result;
}

export function validateNpmSemanticChange(basePackage, headPackage, baseLock, headLock, metadata) {
  const reasons = [];
  const changes = [];
  if (!jsonEqual(stripDependencySections(basePackage), stripDependencySections(headPackage))) {
    reasons.push('package.json changed outside dependency declarations');
  }
  if (
    baseLock?.lockfileVersion !== headLock?.lockfileVersion ||
    baseLock?.name !== headLock?.name ||
    baseLock?.version !== headLock?.version
  ) {
    reasons.push('package-lock.json identity or lockfile format changed');
  }
  const baseRoot = baseLock?.packages?.[''];
  const headRoot = headLock?.packages?.[''];
  if (!baseRoot || !headRoot) reasons.push('package-lock.json is missing the root package record');
  if (
    baseRoot &&
    headRoot &&
    !jsonEqual(stripDependencySections(baseRoot), stripDependencySections(headRoot))
  ) {
    reasons.push('package-lock.json root package changed outside dependency declarations');
  }
  for (const section of DEP_SECTIONS) {
    if (!jsonEqual(headPackage?.[section] || {}, headRoot?.[section] || {})) {
      reasons.push(`package-lock root ${section} does not match package.json`);
    }
  }

  const before = directDependencyMap(basePackage);
  const after = directDependencyMap(headPackage);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const key of keys) {
    const oldEntry = before.get(key);
    const newEntry = after.get(key);
    if (!oldEntry || !newEntry) {
      reasons.push(`direct dependency ${key} was added or removed`);
      continue;
    }
    if (oldEntry.spec === newEntry.spec) continue;
    const comparison = compareSemver(oldEntry.spec, newEntry.spec);
    changes.push({
      ecosystem: 'npm',
      name: oldEntry.name,
      from: oldEntry.spec,
      to: newEntry.spec,
      risk: comparison.risk,
    });
    if (!['patch', 'minor'].includes(comparison.risk))
      reasons.push(`${oldEntry.name}: ${comparison.reason}`);
  }
  if (changes.length === 0)
    reasons.push('no direct dependency version change could be proven from package.json');

  const metadataNames = new Set(metadata.map((item) => item.name));
  for (const change of changes) {
    if (!metadataNames.has(change.name))
      reasons.push(`${change.name} changed but is absent from signed Dependabot metadata`);
  }

  const basePackages = baseLock?.packages || {};
  const headPackages = headLock?.packages || {};
  for (const [packagePath, entry] of Object.entries(headPackages)) {
    if (packagePath === '') continue;
    const previous = basePackages[packagePath];
    if (
      entry?.hasInstallScript === true &&
      previous?.hasInstallScript !== true &&
      !jsonEqual(previous, entry)
    ) {
      reasons.push(`updated lock entry ${packagePath} introduces an install lifecycle script`);
    }
  }

  return { eligible: reasons.length === 0, reasons: unique(reasons), changes };
}

function parseDockerImageReference(line) {
  const match = line.trim().match(/^FROM\s+(?:--platform=\S+\s+)?([^\s]+)(?:\s+AS\s+\S+)?$/i);
  if (!match) return null;
  const reference = match[1];
  const digestIndex = reference.indexOf('@sha256:');
  const withoutDigest = digestIndex >= 0 ? reference.slice(0, digestIndex) : reference;
  const digest = digestIndex >= 0 ? reference.slice(digestIndex + 8) : null;
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  if (colon <= slash) return null;
  const image = withoutDigest.slice(0, colon);
  const tag = withoutDigest.slice(colon + 1);
  const tagMatch = tag.match(/^v?(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!tagMatch) return { image, tag, digest, version: null, suffix: null };
  return {
    image,
    tag,
    digest,
    version: {
      major: Number(tagMatch[1]),
      minor: Number(tagMatch[2]),
      patch: Number(tagMatch[3]),
      raw: `${tagMatch[1]}.${tagMatch[2]}.${tagMatch[3]}`,
    },
    suffix: tagMatch[4] || '',
  };
}

export function validateDockerSemanticChange(baseText, headText, metadata, allowedImages = []) {
  const baseLines = String(baseText).split(/\r?\n/);
  const headLines = String(headText).split(/\r?\n/);
  const reasons = [];
  const changes = [];
  if (baseLines.length !== headLines.length) reasons.push('Dockerfile line count changed');
  const max = Math.max(baseLines.length, headLines.length);
  const differing = [];
  for (let i = 0; i < max; i += 1) if (baseLines[i] !== headLines[i]) differing.push(i);
  if (differing.length === 0) reasons.push('Dockerfile contains no semantic change');
  for (const index of differing) {
    if (
      !/^\s*FROM\s+/i.test(baseLines[index] || '') ||
      !/^\s*FROM\s+/i.test(headLines[index] || '')
    ) {
      reasons.push(`Dockerfile changed outside a FROM line at line ${index + 1}`);
    }
  }
  for (const index of differing) {
    const before = parseDockerImageReference(baseLines[index] || '');
    const after = parseDockerImageReference(headLines[index] || '');
    if (!before || !after) continue;
    const shortName = after.image.split('/').at(-1);
    if (before.image !== after.image)
      reasons.push(`container image identity changed from ${before.image} to ${after.image}`);
    if (
      allowedImages.length > 0 &&
      !allowedImages.includes(shortName) &&
      !allowedImages.includes(after.image)
    ) {
      reasons.push(`container image ${after.image} is not allowlisted for autonomous updates`);
    }
    if (
      !before.digest ||
      !after.digest ||
      !/^[a-f0-9]{64}$/i.test(before.digest) ||
      !/^[a-f0-9]{64}$/i.test(after.digest)
    ) {
      reasons.push('container image must remain pinned by a full sha256 digest');
    }
    if (before.tag === after.tag && before.digest !== after.digest) {
      changes.push({
        ecosystem: 'docker',
        name: after.image,
        from: before.tag,
        to: after.tag,
        risk: 'digest',
      });
      continue;
    }
    if (!before.version || !after.version) {
      reasons.push('container tag version could not be proven as semantic versioning');
      continue;
    }
    if (before.suffix !== after.suffix)
      reasons.push(
        `container platform suffix changed from ${before.suffix || '(none)'} to ${after.suffix || '(none)'}`,
      );
    const comparison = compareSemver(before.version, after.version);
    changes.push({
      ecosystem: 'docker',
      name: after.image,
      from: before.tag,
      to: after.tag,
      risk: comparison.risk,
    });
    if (!['patch', 'minor'].includes(comparison.risk))
      reasons.push(`${after.image}: ${comparison.reason}`);
  }
  const metadataNames = new Set(metadata.map((item) => item.name));
  for (const change of changes) {
    const shortName = change.name.split('/').at(-1);
    if (!metadataNames.has(change.name) && !metadataNames.has(shortName))
      reasons.push(`${change.name} changed but is absent from signed Dependabot metadata`);
  }
  return { eligible: reasons.length === 0, reasons: unique(reasons), changes };
}

function parseActionUseLine(line) {
  const match = line.match(
    /^(\s*-?\s*uses:\s*)([^\s@]+)@([a-f0-9]{40}|[a-f0-9]{64})(\s+#\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*)$/i,
  );
  if (!match) return null;
  return {
    action: match[2],
    sha: match[3],
    version: {
      major: Number(match[5]),
      minor: Number(match[6] || 0),
      patch: Number(match[7] || 0),
      raw: [match[5], match[6], match[7]].filter((part) => part !== undefined).join('.'),
      precision: 1 + (match[6] !== undefined ? 1 : 0) + (match[7] !== undefined ? 1 : 0),
    },
  };
}

export function validateActionsSemanticChange(
  files,
  baseByPath,
  headByPath,
  metadata,
  manualReviewPaths = [],
) {
  const reasons = [];
  const changes = [];
  const metadataByName = new Map(metadata.map((item) => [item.name, item]));
  for (const file of files) {
    const filename = typeof file === 'string' ? file : file.filename;
    if (manualReviewPaths.includes(filename))
      reasons.push(`${filename} is a privileged/control-plane workflow and requires human review`);
    const baseLines = String(baseByPath[filename] || '').split(/\r?\n/);
    const headLines = String(headByPath[filename] || '').split(/\r?\n/);
    if (baseLines.length !== headLines.length) {
      reasons.push(`${filename} changed line structure instead of only a pinned action reference`);
      continue;
    }
    let fileChanges = 0;
    for (let i = 0; i < baseLines.length; i += 1) {
      if (baseLines[i] === headLines[i]) continue;
      fileChanges += 1;
      const before = parseActionUseLine(baseLines[i]);
      const after = parseActionUseLine(headLines[i]);
      if (!before || !after) {
        reasons.push(`${filename}:${i + 1} changed outside the exact pinned-action pattern`);
        continue;
      }
      if (before.action !== after.action) {
        reasons.push(
          `${filename}:${i + 1} changed action identity from ${before.action} to ${after.action}`,
        );
        continue;
      }
      const signed = metadataByName.get(after.action);
      if (!signed) {
        reasons.push(`${after.action} changed but is absent from signed Dependabot metadata`);
        continue;
      }
      if (before.version.major !== after.version.major) {
        changes.push({
          ecosystem: 'github-actions',
          name: after.action,
          from: before.version.raw,
          to: after.version.raw,
          risk: 'major',
        });
        reasons.push(`${after.action}: action annotation crosses a major version`);
        continue;
      }
      let comparison = compareSemver(before.version, after.version);
      if (comparison.risk === 'same') {
        if (/semver-patch$/.test(signed.updateType || ''))
          comparison = {
            risk: 'patch',
            reason: 'signed Dependabot patch update with coarse action annotation',
          };
        else if (/semver-minor$/.test(signed.updateType || ''))
          comparison = {
            risk: 'minor',
            reason: 'signed Dependabot minor update with coarse action annotation',
          };
      }
      if (before.version.major === 0 && comparison.risk === 'minor') {
        comparison = {
          risk: 'major-risk',
          reason: '0.x action minor transition treated as breaking-risk',
        };
      }
      changes.push({
        ecosystem: 'github-actions',
        name: after.action,
        from: before.version.raw,
        to: after.version.raw,
        risk: comparison.risk,
      });
      if (!['patch', 'minor'].includes(comparison.risk))
        reasons.push(`${after.action}: ${comparison.reason}`);
    }
    if (fileChanges === 0) reasons.push(`${filename} contains no action reference change`);
  }
  return { eligible: reasons.length === 0, reasons: unique(reasons), changes };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function validateConfig(config) {
  const errors = [];
  const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
  if (config?.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (config?.botLogin !== 'dependabot[bot]') errors.push('botLogin must be dependabot[bot]');
  if (!Number.isInteger(config?.botUserId) || config.botUserId <= 0)
    errors.push('botUserId must be a positive integer');
  if (!nonEmpty(config?.botAuthorEmail)) errors.push('botAuthorEmail must be non-empty');
  if (!nonEmpty(config?.trustedCommitterLogin))
    errors.push('trustedCommitterLogin must be non-empty');
  if (!nonEmpty(config?.gitCommitterName) || !nonEmpty(config?.gitCommitterEmail))
    errors.push('git committer identity must be configured');
  if (!nonEmpty(config?.signedOffBy)) errors.push('signedOffBy must be non-empty');
  if (!nonEmpty(config?.baseBranch)) errors.push('baseBranch must be non-empty');
  if (!['merge', 'squash', 'rebase'].includes(config?.mergeMethod))
    errors.push('mergeMethod is invalid');
  if (typeof config?.automergeEnabled !== 'boolean')
    errors.push('automergeEnabled must be boolean');
  if (
    !Number.isInteger(config?.maxChangedFiles) ||
    config.maxChangedFiles < 1 ||
    config.maxChangedFiles > 100
  )
    errors.push('maxChangedFiles must be an integer from 1 to 100');
  if (
    !Number.isInteger(config?.maxPullRequestAgeDays) ||
    config.maxPullRequestAgeDays < 1 ||
    config.maxPullRequestAgeDays > 90
  )
    errors.push('maxPullRequestAgeDays must be an integer from 1 to 90');
  if (
    !Number.isInteger(config?.maxPaginationPages) ||
    config.maxPaginationPages < 1 ||
    config.maxPaginationPages > 20
  )
    errors.push('maxPaginationPages must be an integer from 1 to 20');
  if (!Array.isArray(config?.manualReviewLabels) || config.manualReviewLabels.length === 0)
    errors.push('manualReviewLabels must be non-empty');
  if (!Array.isArray(config?.requiredWorkflows) || config.requiredWorkflows.length === 0)
    errors.push('requiredWorkflows must be non-empty');
  const workflowNames = new Set();
  const gateNames = new Set();
  const workflowFiles = new Set();
  for (const item of config?.requiredWorkflows || []) {
    if (!item.workflow || !item.gate || !item.file)
      errors.push('each required workflow needs workflow, gate, and dispatch file');
    if (item.file && (item.file.includes('/') || !/^[A-Za-z0-9._-]+\.ya?ml$/.test(item.file)))
      errors.push(`workflow file ${item.file} must be a basename ending in .yml or .yaml`);
    if (workflowNames.has(item.workflow)) errors.push(`duplicate workflow ${item.workflow}`);
    if (gateNames.has(item.gate)) errors.push(`duplicate gate ${item.gate}`);
    if (workflowFiles.has(item.file)) errors.push(`duplicate workflow file ${item.file}`);
    workflowNames.add(item.workflow);
    gateNames.add(item.gate);
    workflowFiles.add(item.file);
  }
  if (
    !Array.isArray(config?.allowedUpdateTypes) ||
    config.allowedUpdateTypes.length === 0 ||
    config.allowedUpdateTypes.some((type) => /major/.test(type))
  ) {
    errors.push('allowedUpdateTypes must exist and must never include major updates');
  }
  for (const critical of [
    '.github/workflows/security.yml',
    '.github/workflows/dependency-governance.yml',
    '.github/dependency-governance.json',
    '.github/scripts/dependency-governance.mjs',
    '.github/scripts/dependency-governance.selfcheck.mjs',
  ]) {
    if (!config?.manualReviewPaths?.includes(critical))
      errors.push(`${critical} must require manual review`);
  }
  if (!Array.isArray(config?.ecosystems?.npm?.files) || config.ecosystems.npm.files.length === 0)
    errors.push('npm ecosystem files must be configured');
  if (
    !Array.isArray(config?.ecosystems?.docker?.files) ||
    config.ecosystems.docker.files.length === 0
  )
    errors.push('docker ecosystem files must be configured');
  if (
    !Array.isArray(config?.ecosystems?.docker?.allowedImages) ||
    config.ecosystems.docker.allowedImages.length === 0
  )
    errors.push('docker allowedImages must be non-empty');
  if (
    !nonEmpty(config?.ecosystems?.['github-actions']?.workflowPrefix) ||
    !Array.isArray(config?.ecosystems?.['github-actions']?.extensions)
  )
    errors.push('github-actions ecosystem policy is incomplete');
  return unique(errors);
}

export function parsePositiveInteger(value, name = 'value') {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${name} must be a positive integer`);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} exceeds the safe integer range`);
  return number;
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

  async request(method, url, body) {
    const response = await globalThis.fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dependency-governance-bot',
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
    if (!response.ok) {
      const message = typeof payload === 'object' ? payload?.message : payload;
      throw new Error(
        `GitHub API ${method} ${url} failed (${response.status}): ${message || 'unknown error'}`,
      );
    }
    return payload;
  }

  get(pathname) {
    return this.request('GET', pathname.startsWith('http') ? pathname : `${this.root}${pathname}`);
  }
  post(pathname, body) {
    return this.request(
      'POST',
      pathname.startsWith('http') ? pathname : `${this.root}${pathname}`,
      body,
    );
  }
  patch(pathname, body) {
    return this.request(
      'PATCH',
      pathname.startsWith('http') ? pathname : `${this.root}${pathname}`,
      body,
    );
  }
  put(pathname, body) {
    return this.request(
      'PUT',
      pathname.startsWith('http') ? pathname : `${this.root}${pathname}`,
      body,
    );
  }

  async paginate(pathname, selector = null) {
    const values = [];
    for (let page = 1; page <= this.maxPaginationPages; page += 1) {
      const separator = pathname.includes('?') ? '&' : '?';
      const payload = await this.get(`${pathname}${separator}per_page=${PAGE_SIZE}&page=${page}`);
      const pageValues = selector ? payload?.[selector] : payload;
      if (!Array.isArray(pageValues))
        throw new Error(`pagination endpoint ${pathname} did not return ${selector || 'an array'}`);
      values.push(...pageValues);
      if (pageValues.length < PAGE_SIZE) return values;
    }
    throw new Error(
      `pagination safety limit reached for ${pathname} after ${this.maxPaginationPages} page(s)`,
    );
  }

  async fileAt(filename, ref) {
    const encodedPath = filename.split('/').map(encodeURIComponent).join('/');
    const payload = await this.get(`/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
    if (payload?.encoding !== 'base64' || typeof payload?.content !== 'string')
      throw new Error(`Unable to decode ${filename}@${ref}`);
    return Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8');
  }
}

function loadConfig(configPath = process.env.GOVERNANCE_CONFIG || DEFAULT_CONFIG_PATH) {
  const absolute = path.resolve(configPath);
  const config = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  const errors = validateConfig(config);
  if (errors.length)
    throw new Error(`Invalid dependency governance config:\n- ${errors.join('\n- ')}`);
  return config;
}

async function getCurrentBaseSha(api, branch) {
  const ref = await api.get(`/git/ref/heads/${encodeURIComponent(branch)}`);
  return ref.object.sha;
}

async function getPull(api, number) {
  return api.get(`/pulls/${number}`);
}

async function getPullFiles(api, pull) {
  if (pull.changed_files > 100)
    throw new Error(
      `PR changes ${pull.changed_files} files; refusing to paginate an oversized autonomous change`,
    );
  return api.get(`/pulls/${pull.number}/files?per_page=100`);
}

async function getPullCommits(api, pull) {
  if (pull.commits > 100)
    throw new Error(`PR contains ${pull.commits} commits; refusing oversized autonomous history`);
  return api.get(`/pulls/${pull.number}/commits?per_page=100`);
}

export function validateProvenance({ pull, commits, baseSha, config, now = new Date() }) {
  const reasons = [];
  if (pull.user?.login !== config.botLogin)
    reasons.push(`PR author is ${pull.user?.login || 'unknown'}, not ${config.botLogin}`);
  if (pull.user?.id !== config.botUserId)
    reasons.push(
      `PR author numeric identity is ${pull.user?.id ?? 'unknown'}, expected ${config.botUserId}`,
    );
  if (pull.base?.ref !== config.baseBranch)
    reasons.push(`base branch is ${pull.base?.ref}, expected ${config.baseBranch}`);
  if (pull.head?.repo?.full_name !== pull.base?.repo?.full_name)
    reasons.push('Dependabot PR head must be in the same repository');
  if (!String(pull.head?.ref || '').startsWith('dependabot/'))
    reasons.push('head branch is not a Dependabot branch');
  if (pull.draft) reasons.push('draft PRs are never autonomously merged');
  if (config.automergeEnabled !== true)
    reasons.push('repository autonomous merge kill switch is disabled');
  const labels = new Set(
    (pull.labels || [])
      .map((label) => (typeof label === 'string' ? label : label.name))
      .filter(Boolean),
  );
  for (const label of config.manualReviewLabels || [])
    if (labels.has(label)) reasons.push(`PR carries manual-review label ${label}`);
  const createdAt = new Date(pull.created_at);
  if (Number.isNaN(createdAt.getTime())) reasons.push('PR creation timestamp is invalid');
  else if (now.getTime() - createdAt.getTime() > config.maxPullRequestAgeDays * 86_400_000)
    reasons.push(`PR is older than autonomous limit ${config.maxPullRequestAgeDays} day(s)`);
  if (commits.length !== 1 || pull.commits !== 1)
    reasons.push('autonomous merge requires exactly one Dependabot commit');
  const commit = commits[0];
  if (commit) {
    if (commit.author?.login !== config.botLogin)
      reasons.push(`commit author is ${commit.author?.login || 'unknown'}, not ${config.botLogin}`);
    if (commit.author?.id !== config.botUserId)
      reasons.push(
        `commit author numeric identity is ${commit.author?.id ?? 'unknown'}, expected ${config.botUserId}`,
      );
    if (commit.committer?.login !== config.trustedCommitterLogin)
      reasons.push(
        `commit was materialized by ${commit.committer?.login || 'unknown'}, expected ${config.trustedCommitterLogin}`,
      );
    if (commit.commit?.author?.name !== config.botLogin)
      reasons.push('Git commit author name does not match Dependabot');
    if (commit.commit?.author?.email !== config.botAuthorEmail)
      reasons.push('Git commit author email does not match canonical Dependabot identity');
    if (
      commit.commit?.committer?.name !== config.gitCommitterName ||
      commit.commit?.committer?.email !== config.gitCommitterEmail
    )
      reasons.push('Git commit committer identity does not match GitHub signing infrastructure');
    if (
      commit.commit?.verification?.verified !== true ||
      commit.commit?.verification?.reason !== 'valid'
    )
      reasons.push('Dependabot commit signature is not GitHub-verified as valid');
    if (
      typeof commit.commit?.verification?.signature !== 'string' ||
      commit.commit.verification.signature.length === 0
    )
      reasons.push('Dependabot commit has no verifiable signature material');
    if (!String(commit.commit?.message || '').includes(config.signedOffBy))
      reasons.push('Dependabot commit is missing the canonical Signed-off-by trailer');
    if (commit.parents?.length !== 1) reasons.push('Dependabot commit must not be a merge commit');
    if (commit.parents?.[0]?.sha !== baseSha)
      reasons.push('PR is not rebased directly on the current base branch head');
    if (commit.sha !== pull.head?.sha)
      reasons.push('PR head SHA does not equal the verified Dependabot commit SHA');
  }
  return { eligible: reasons.length === 0, reasons: unique(reasons), commit };
}

export function validateSignedMetadata(commit, config) {
  const metadata = parseDependabotMetadata(commit?.commit?.message || '');
  const reasons = [];
  if (metadata.length === 0)
    reasons.push('verified Dependabot commit contains no updated-dependencies metadata');
  for (const item of metadata) {
    if (!item.name || !item.version || !item.updateType)
      reasons.push('Dependabot metadata entry is incomplete');
    if (!config.allowedUpdateTypes.includes(item.updateType))
      reasons.push(
        `${item.name || 'dependency'} uses non-autonomous update type ${item.updateType || 'unknown'}`,
      );
  }
  return { eligible: reasons.length === 0, reasons: unique(reasons), metadata };
}

export function workflowIdentityMatches(run, pull, requirement) {
  const expectedPath = `.github/workflows/${requirement.file}`;
  const associationMatches =
    !Array.isArray(run?.pull_requests) ||
    run.pull_requests.length === 0 ||
    run.pull_requests.some((item) => item.number === pull.number);
  return (
    run?.name === requirement.workflow &&
    run?.path === expectedPath &&
    run?.event === 'pull_request' &&
    run?.head_sha === pull.head.sha &&
    run?.head_branch === pull.head.ref &&
    associationMatches
  );
}

export function selectQualificationRun(runs, pull, requirement) {
  return (
    runs
      .filter((run) => workflowIdentityMatches(run, pull, requirement))
      .sort(
        (a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at),
      )[0] || null
  );
}

export async function reconcileIndependently(pulls, processor) {
  const results = [];
  const failures = [];
  for (const pull of pulls) {
    try {
      results.push({ number: pull.number, result: await processor(pull) });
    } catch (error) {
      failures.push({ number: pull.number, error: error?.message || String(error) });
    }
  }
  return { results, failures };
}

async function validateChangeSemantics({ api, pull, files, ecosystem, metadata, config }) {
  const baseRef = pull.base.sha;
  const headRef = pull.head.sha;
  if (ecosystem === 'npm') {
    const [basePackageText, headPackageText, baseLockText, headLockText] = await Promise.all([
      api.fileAt('package.json', baseRef),
      api.fileAt('package.json', headRef),
      api.fileAt('package-lock.json', baseRef),
      api.fileAt('package-lock.json', headRef),
    ]);
    return validateNpmSemanticChange(
      JSON.parse(basePackageText),
      JSON.parse(headPackageText),
      JSON.parse(baseLockText),
      JSON.parse(headLockText),
      metadata,
    );
  }
  if (ecosystem === 'docker') {
    const filename = files[0].filename;
    const [baseText, headText] = await Promise.all([
      api.fileAt(filename, baseRef),
      api.fileAt(filename, headRef),
    ]);
    return validateDockerSemanticChange(
      baseText,
      headText,
      metadata,
      config.ecosystems.docker.allowedImages || [],
    );
  }
  if (ecosystem === 'github-actions') {
    const baseByPath = {};
    const headByPath = {};
    await Promise.all(
      files.flatMap((file) => [
        api.fileAt(file.filename, baseRef).then((text) => {
          baseByPath[file.filename] = text;
        }),
        api.fileAt(file.filename, headRef).then((text) => {
          headByPath[file.filename] = text;
        }),
      ]),
    );
    return validateActionsSemanticChange(
      files,
      baseByPath,
      headByPath,
      metadata,
      config.manualReviewPaths || [],
    );
  }
  return {
    eligible: false,
    reasons: ['changed-file set does not map to one allowlisted dependency ecosystem'],
    changes: [],
  };
}

async function qualificationForHead(api, pull, config) {
  const runs = await api.paginate(
    `/actions/runs?head_sha=${encodeURIComponent(pull.head.sha)}&event=pull_request`,
    'workflow_runs',
  );
  const qualifications = [];
  for (const requirement of config.requiredWorkflows) {
    const run = selectQualificationRun(runs, pull, requirement);
    if (!run) {
      qualifications.push({ ...requirement, state: 'missing', runId: null });
      continue;
    }
    if (run.status !== 'completed') {
      qualifications.push({ ...requirement, state: 'pending', runId: run.id });
      continue;
    }
    if (run.conclusion !== 'success') {
      qualifications.push({
        ...requirement,
        state: `run-${run.conclusion || 'unknown'}`,
        runId: run.id,
      });
      continue;
    }
    const jobs = await api.paginate(`/actions/runs/${run.id}/jobs?filter=latest`, 'jobs');
    const gate = jobs.filter((job) => job.name === requirement.gate).sort((a, b) => b.id - a.id)[0];
    if (!gate) qualifications.push({ ...requirement, state: 'gate-missing', runId: run.id });
    else if (gate.status !== 'completed')
      qualifications.push({ ...requirement, state: 'gate-pending', runId: run.id });
    else if (gate.conclusion !== 'success')
      qualifications.push({
        ...requirement,
        state: `gate-${gate.conclusion || 'unknown'}`,
        runId: run.id,
      });
    else qualifications.push({ ...requirement, state: 'success', runId: run.id });
  }
  const allSuccess = qualifications.every((item) => item.state === 'success');
  const anyFailed = qualifications.some(
    (item) => !['success', 'missing', 'pending', 'gate-pending'].includes(item.state),
  );
  return { allSuccess, anyFailed, qualifications };
}

function renderComment({ assessment, config, merged = false, dispatches = [] }) {
  const { pull, provenance, metadataAssessment, ecosystem, semantic, qualification, baseSha } =
    assessment;
  const state = merged
    ? '✅ merged by governed automation'
    : !provenance.eligible || !metadataAssessment.eligible || !semantic.eligible
      ? '🛑 manual review required'
      : qualification?.allSuccess
        ? '✅ eligible and fully qualified'
        : qualification?.anyFailed
          ? '❌ qualification failed'
          : '⏳ eligible; waiting for required qualification';
  const lines = [
    config.statusCommentMarker,
    '### Dependency governance',
    '',
    `**State:** ${state}`,
    '',
    '| Proof | Result |',
    '| --- | --- |',
    `| PR provenance | ${provenance.eligible ? '✅ verified single signed Dependabot commit' : '❌ manual'} |`,
    `| Base freshness | ${provenance.commit?.parents?.[0]?.sha === baseSha ? '✅ directly based on current `main`' : '❌ stale or non-linear'} |`,
    `| Ecosystem | \`${ecosystem}\` |`,
    `| Signed update metadata | ${metadataAssessment.eligible ? '✅ minor/patch class only' : '❌ contains unknown/major-risk class'} |`,
    `| Semantic scope | ${semantic.eligible ? '✅ allowlisted dependency-only change' : '❌ manual'} |`,
    '',
  ];
  if (semantic.changes?.length) {
    lines.push(
      '**Proven dependency changes**',
      '',
      '| Dependency | From | To | Risk |',
      '| --- | --- | --- | --- |',
    );
    for (const change of semantic.changes)
      lines.push(
        `| \`${change.name}\` | \`${change.from}\` | \`${change.to}\` | \`${change.risk}\` |`,
      );
    lines.push('');
  }
  const blockers = unique([
    ...provenance.reasons,
    ...metadataAssessment.reasons,
    ...semantic.reasons,
  ]);
  if (blockers.length) {
    lines.push('**Why autonomous merge is blocked**', '');
    for (const reason of blockers) lines.push(`- ${reason}`);
    lines.push('');
  }
  if (qualification) {
    lines.push(
      '**Exact-head qualification**',
      '',
      '| Workflow | Stable gate | State |',
      '| --- | --- | --- |',
    );
    for (const item of qualification.qualifications)
      lines.push(`| \`${item.workflow}\` | \`${item.gate}\` | \`${item.state}\` |`);
    lines.push('');
  }
  if (merged && dispatches.length) {
    lines.push(
      '**Post-merge main requalification dispatch**',
      '',
      '| Workflow | Dispatch |',
      '| --- | --- |',
    );
    for (const item of dispatches) lines.push(`| \`${item.workflow}\` | \`${item.state}\` |`);
    const failures = dispatches.filter((item) => item.state !== 'requested');
    if (failures.length) {
      lines.push(
        '',
        '⚠️ Merge completed, but one or more explicit `main` requalification dispatches failed. This is an operational incident and must be investigated; the pre-merge qualification remains recorded above.',
      );
    }
    lines.push('');
  }
  lines.push(
    `Head: \`${pull.head.sha}\``,
    '',
    '> Safety invariant: privileged governance runs only trusted code from the default branch, never checks out or executes the Dependabot PR head, requires exact-head test/security gates, and never autonomously merges major, downgrade, prerelease, unknown, stale-base, or control-plane changes.',
  );
  return `${lines.join('\n')}\n`;
}

async function upsertComment(api, pullNumber, marker, body) {
  const comments = await api.paginate(`/issues/${pullNumber}/comments`);
  const matches = comments.filter(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' && String(comment.body || '').includes(marker),
  );
  if (matches.length > 1)
    throw new Error(
      `found ${matches.length} governance status comments; refusing ambiguous idempotent update`,
    );
  if (matches.length === 1) return api.patch(`/issues/comments/${matches[0].id}`, { body });
  return api.post(`/issues/${pullNumber}/comments`, { body });
}

async function assessPull(api, number, config, { includeQualification = true } = {}) {
  const pull = await getPull(api, number);
  const baseSha = await getCurrentBaseSha(api, config.baseBranch);
  let files = [];
  let commits;
  try {
    [files, commits] = await Promise.all([getPullFiles(api, pull), getPullCommits(api, pull)]);
  } catch (error) {
    const fallback = { eligible: false, reasons: [error.message], commit: null };
    return {
      pull,
      baseSha,
      files,
      ecosystem: 'unknown',
      provenance: fallback,
      metadataAssessment: {
        eligible: false,
        reasons: ['provenance could not be established'],
        metadata: [],
      },
      semantic: { eligible: false, reasons: ['change semantics were not evaluated'], changes: [] },
      qualification: includeQualification
        ? { allSuccess: false, anyFailed: false, qualifications: [] }
        : null,
    };
  }
  const provenance = validateProvenance({ pull, commits, baseSha, config });
  const metadataAssessment = provenance.commit
    ? validateSignedMetadata(provenance.commit, config)
    : { eligible: false, reasons: ['no single verified Dependabot commit'], metadata: [] };
  const ecosystem = classifyEcosystem(files, config);
  let semantic = { eligible: false, reasons: [], changes: [] };
  if (files.length > config.maxChangedFiles)
    semantic.reasons.push(
      `PR changes ${files.length} files, exceeding autonomous limit ${config.maxChangedFiles}`,
    );
  if (pull.changed_files !== files.length)
    semantic.reasons.push(
      `GitHub reports ${pull.changed_files} changed files but ${files.length} were enumerated`,
    );
  if (provenance.eligible && metadataAssessment.eligible && semantic.reasons.length === 0) {
    const evaluated = await validateChangeSemantics({
      api,
      pull,
      files,
      ecosystem,
      metadata: metadataAssessment.metadata,
      config,
    });
    semantic = { ...evaluated, reasons: unique([...semantic.reasons, ...evaluated.reasons]) };
  } else if (semantic.reasons.length === 0) {
    semantic.reasons.push(
      'semantic auto-merge evaluation skipped because provenance or signed metadata is not eligible',
    );
  }
  const qualification =
    includeQualification && provenance.eligible && metadataAssessment.eligible && semantic.eligible
      ? await qualificationForHead(api, pull, config)
      : includeQualification
        ? {
            allSuccess: false,
            anyFailed: false,
            qualifications: config.requiredWorkflows.map((item) => ({
              ...item,
              state: 'not-evaluated',
              runId: null,
            })),
          }
        : null;
  return {
    pull,
    baseSha,
    files,
    ecosystem,
    provenance,
    metadataAssessment,
    semantic,
    qualification,
  };
}

async function maybeMerge(api, assessment, config, allowMerge) {
  const eligible =
    assessment.provenance.eligible &&
    assessment.metadataAssessment.eligible &&
    assessment.semantic.eligible;
  if (!eligible || !assessment.qualification?.allSuccess || !allowMerge) return { merged: false };

  const refreshed = await assessPull(api, assessment.pull.number, config, {
    includeQualification: true,
  });
  const stillEligible =
    refreshed.pull.state === 'open' &&
    refreshed.pull.head.sha === assessment.pull.head.sha &&
    refreshed.provenance.eligible &&
    refreshed.metadataAssessment.eligible &&
    refreshed.semantic.eligible &&
    refreshed.qualification.allSuccess;
  if (!stillEligible) return { merged: false, refreshed };

  const result = await api.put(`/pulls/${refreshed.pull.number}/merge`, {
    merge_method: config.mergeMethod,
    sha: refreshed.pull.head.sha,
    commit_title: refreshed.pull.title,
    commit_message:
      'Qualified and merged by dependency governance after provenance, semantic-scope, exact-base, CI, extended, security, and documentation gates.',
  });
  const dispatches = [];
  if (result?.merged === true) {
    for (const requirement of config.requiredWorkflows) {
      try {
        await api.post(`/actions/workflows/${encodeURIComponent(requirement.file)}/dispatches`, {
          ref: config.baseBranch,
        });
        dispatches.push({
          workflow: requirement.workflow,
          file: requirement.file,
          state: 'requested',
        });
      } catch (error) {
        dispatches.push({
          workflow: requirement.workflow,
          file: requirement.file,
          state: 'failed',
          error: error.message,
        });
      }
    }
  }
  return { merged: result?.merged === true, result, refreshed, dispatches };
}

export function eventPullNumber(event, eventName) {
  if (eventName === 'pull_request_target' || eventName === 'pull_request')
    return event.pull_request?.number || null;
  if (eventName === 'workflow_dispatch') {
    const value = event.inputs?.['pr-number'];
    return value == null || value === ''
      ? null
      : parsePositiveInteger(value, 'workflow_dispatch pr-number');
  }
  if (eventName === 'workflow_run') return event.workflow_run?.pull_requests?.[0]?.number || null;
  return null;
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

async function processPull(api, number, config, { allowMerge, includeQualification = true }) {
  const assessment = await assessPull(api, number, config, { includeQualification });
  if (
    assessment.pull.user?.login !== config.botLogin ||
    assessment.pull.user?.id !== config.botUserId
  )
    return { skipped: true, reason: 'not canonical Dependabot' };
  const mergeAttempt = await maybeMerge(api, assessment, config, allowMerge);
  const finalAssessment = mergeAttempt.refreshed || assessment;
  const body = renderComment({
    assessment: finalAssessment,
    config,
    merged: mergeAttempt.merged,
    dispatches: mergeAttempt.dispatches || [],
  });
  await upsertComment(api, number, config.statusCommentMarker, body);
  const failedDispatches = (mergeAttempt.dispatches || []).filter(
    (item) => item.state !== 'requested',
  );
  if (mergeAttempt.merged && failedDispatches.length) {
    throw new Error(
      `Merge succeeded but ${failedDispatches.length} post-merge workflow dispatch(es) failed: ${failedDispatches.map((item) => `${item.workflow}: ${item.error}`).join('; ')}`,
    );
  }
  return { skipped: false, assessment: finalAssessment, merged: mergeAttempt.merged };
}

async function main() {
  const config = loadConfig();
  if (process.argv.includes('--validate-config')) {
    console.log('dependency-governance config: valid');
    return;
  }
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventName || !eventPath)
    throw new Error('GITHUB_EVENT_NAME and GITHUB_EVENT_PATH are required');
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const api = new GitHubApi({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    maxPaginationPages: config.maxPaginationPages,
  });
  const allowMerge = process.env.ALLOW_MERGE === 'true';

  if (eventName === 'schedule') {
    const pulls = await api.paginate('/pulls?state=open');
    const dependabotPulls = pulls.filter(
      (pull) => pull.user?.login === config.botLogin && pull.user?.id === config.botUserId,
    );
    const reconciliation = await reconcileIndependently(dependabotPulls, (pull) =>
      processPull(api, pull.number, config, { allowMerge, includeQualification: true }),
    );
    console.log(
      JSON.stringify(
        { reconciled: reconciliation.results.length, failed: reconciliation.failures },
        null,
        2,
      ),
    );
    if (reconciliation.failures.length)
      throw new Error(
        `scheduled dependency governance failed for ${reconciliation.failures.length} PR(s)`,
      );
    return;
  }

  let number = eventPullNumber(event, eventName);
  if (!number && eventName === 'workflow_run') number = await resolveWorkflowRunPull(api, event);
  if (!number) {
    console.log(`No pull request resolved for ${eventName}; nothing to do.`);
    return;
  }
  const result = await processPull(api, number, config, { allowMerge, includeQualification: true });
  console.log(
    JSON.stringify(
      { pr: number, skipped: result.skipped, merged: result.merged || false },
      null,
      2,
    ),
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
