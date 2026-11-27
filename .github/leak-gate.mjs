#!/usr/bin/env node
// Leak gate: stops private material reaching this public repository.
// How it works, the fork-PR rule and the maintainer steps: .github/LEAK-GATE.md
//
// It reads git objects only (never the working tree), needs no dependencies, and never
// prints a matched value or a blocklist label: this repository's CI logs are public.
//
//   node .github/leak-gate.mjs             judge LEAK_GATE_BASE..LEAK_GATE_HEAD
//   node .github/leak-gate.mjs --tree      judge every file tracked at LEAK_GATE_HEAD
//   node .github/leak-gate.mjs --selftest  prove it detects and fails closed
// Exit: 0 clean · 1 blocked · 2 could not run

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SECRET = 'PII_BLOCKLIST_JSON';
const CATEGORIES = ['ipv4', 'email', 'phrase', 'chain-address'];

// ── blocklist (hashed, supplied out of band, never committed) ───────────────
const normalize = (category, value) => {
  const v = String(value).trim().toLowerCase();
  return category === 'phrase' ? v.replace(/\s+/g, ' ') : v;
};
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// Error text is fixed: a JSON.parse message quotes its input, which here is the secret.
function parseBlocklist(json) {
  let entries;
  try { entries = JSON.parse(json).entries; } catch { throw new Error('blocklist is not valid JSON'); }
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('blocklist has no entries');
  const exact = new Set();
  const phrases = new Map(); // length -> Set(hash)
  entries.forEach((e, i) => {
    const ok = e && /^[0-9a-f]{64}$/.test(e.sha256) && CATEGORIES.includes(e.category)
      && (e.category !== 'phrase' || (Number.isInteger(e.len) && e.len > 0));
    if (!ok) throw new Error(`blocklist entry ${i} is malformed`);
    if (e.category !== 'phrase') exact.add(`${e.category}:${e.sha256}`);
    else {
      if (!phrases.has(e.len)) phrases.set(e.len, new Set());
      phrases.get(e.len).add(e.sha256);
    }
  });
  return { exact, phrases, size: entries.length };
}

function loadBlocklist(env) {
  if (env[SECRET]?.trim()) return parseBlocklist(env[SECRET]);
  const path = env.PII_BLOCKLIST_LOCAL_PATH;
  if (path && existsSync(path)) return parseBlocklist(readFileSync(path, 'utf8'));
  return null;
}

// ── content rules ───────────────────────────────────────────────────────────
// A real home-directory path, or the dash-mangled form some tools make from one.
const HOME_RES = [
  /\/Users\/([A-Za-z0-9._-]+)(?=\/|[)"'`]|\s|$)/g,
  /-Users-([A-Za-z0-9._-]+?)-Projects\b/g,
];
const PLACEHOLDERS = new Set(['you', 'your-name', 'yourname', 'your_name', 'username', 'user', 'name', 'example', 'test', 'ci', 'runner']);
const CANDIDATES = {
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  'chain-address': /\b[a-z][a-z0-9]{2,24}_rdx1[0-9a-z]{20,90}\b/g,
};

function scanText(text, blocklist) {
  const hits = new Set();
  for (const re of HOME_RES) {
    for (const m of text.matchAll(re)) if (!PLACEHOLDERS.has(m[1].toLowerCase())) hits.add('home-path');
  }
  if (!blocklist) return hits;
  for (const [category, re] of Object.entries(CANDIDATES)) {
    for (const m of text.matchAll(re)) {
      if (blocklist.exact.has(`${category}:${sha(normalize(category, m[0]))}`)) hits.add(`blocklisted ${category}`);
    }
  }
  if (blocklist.phrases.size) {
    const line = normalize('phrase', text);
    for (const [len, hashes] of blocklist.phrases) {
      for (let i = 0; i + len <= line.length; i++) {
        if (hashes.has(sha(line.slice(i, i + len)))) { hits.add('blocklisted phrase'); break; }
      }
    }
  }
  return hits;
}

// ── branch and path rules ───────────────────────────────────────────────────
const PRIVATE_BRANCH = /^(?:refs\/heads\/)?(?:sdk-run|audit)\//i;
const PRIVATE_MERGE = /^Merge .*(?<![A-Za-z0-9_-])(?:sdk-run|audit)\//i;
const AUDIT_DIR = /(?:^|\/)(?:audits?|audit-reports?|pentests?|security-findings)\//i;
const AUDIT_DOC = /(?:^|\/)[^/]*(?:audit|pentest|findings)[^/]*\.(?:md|markdown|txt|pdf|docx?|html|json|ya?ml|csv)$/i;

// LEAK_GATE_AUDIT_ALLOW (set in the workflow file) is a regex of paths that may carry audit names.
function isAuditPath(path, allow) {
  if (/(?:^|\/)\.gitkeep$|^\.github\/workflows\//.test(path)) return false;
  if (allow && allow.test(path)) return false;
  return AUDIT_DIR.test(path) || AUDIT_DOC.test(path);
}

// ── commit identity (maintainer branches only) ──────────────────────────────
const SAFE_EMAIL = /^(?:(?:\d+\+)?[a-z0-9-]{1,39}(?:\[bot\])?@users\.noreply\.github\.com|noreply@github\.com|noreply@anthropic\.com)$/i;
const SAFE_NAME = /^(?:bigdev|bigdevxrd|radixguild|github|claude(?: [a-z0-9. ]+)?|dependabot\[bot\]|github-actions\[bot\])$/i;

// ── git ─────────────────────────────────────────────────────────────────────
const git = (cwd, args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
  cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const DIFF_FLAGS = ['--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];

function addedLines(diff, visit) {
  let path = '';
  let inHunk = false;
  let line = 0;
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) { inHunk = false; path = ''; continue; }
    if (!inHunk && row.startsWith('+++ ')) { path = row.slice(4).replace(/^b\//, '').replace(/\t$/, ''); continue; }
    const hunk = row.match(/^@@ -\S+ \+(\d+)/);
    if (hunk) { inHunk = true; line = Number(hunk[1]); continue; }
    if (inHunk && row.startsWith('+')) visit(path, line++, row.slice(1));
  }
}

const addedPaths = (cwd, from, to) => git(cwd, ['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', from, to]).split('\0').filter(Boolean);

// ── the gate ────────────────────────────────────────────────────────────────
function run({ cwd, env, tree = false, out = console.log }) {
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pr = event.pull_request;
  const isFork = Boolean(pr) && pr.head?.repo?.full_name !== pr.base?.repo?.full_name;

  const blocklist = loadBlocklist(env);
  if (!blocklist && !isFork) {
    out(`leak-gate: BLOCKED. No blocklist: add the ${SECRET} secret (Actions and Dependabot), or set PII_BLOCKLIST_LOCAL_PATH locally. See .github/LEAK-GATE.md.`);
    return 1;
  }
  if (!blocklist) {
    out('::warning::Pull request from a fork: secrets are not available, so the blocklist layer did NOT run. A maintainer runs it before merge (.github/LEAK-GATE.md).');
  } else out(`leak-gate: blocklist loaded (${blocklist.size} entries)`);

  const allow = env.LEAK_GATE_AUDIT_ALLOW ? new RegExp(env.LEAK_GATE_AUDIT_ALLOW) : null;
  const findings = new Set();
  const judge = (where, text) => { for (const hit of scanText(text, blocklist)) findings.add(`${where}: ${hit}`); };
  const head = git(cwd, ['rev-parse', '--verify', `${env.LEAK_GATE_HEAD || 'HEAD'}^{commit}`]).trim();

  if (tree) {
    const empty = git(cwd, ['hash-object', '-t', 'tree', '/dev/null']).trim();
    addedLines(git(cwd, ['diff', ...DIFF_FLAGS, empty, head]), (p, n, text) => judge(`${p}:${n}`, text));
    for (const p of addedPaths(cwd, empty, head)) {
      judge('a file path', p);
      if (isAuditPath(p, allow)) findings.add(`${p}: audit-shaped file`);
    }
  } else {
    for (const ref of [env.GITHUB_HEAD_REF, env.GITHUB_REF, env.LEAK_GATE_BRANCH]) {
      if (ref && PRIVATE_BRANCH.test(ref)) findings.add('branch name: sdk-run/* and audit/* branches never reach this repo');
    }
    for (const ref of [env.GITHUB_HEAD_REF, env.LEAK_GATE_BRANCH]) if (ref) judge('branch name', ref);

    // Base: explicit, else the PR base branch, else the pre-push tip, else origin/main.
    const before = /^0+$/.test(event.before ?? '') ? '' : event.before;
    const baseRef = env.LEAK_GATE_BASE || (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : before || 'origin/main');
    const mergeBase = git(cwd, ['merge-base', baseRef, head]).trim();
    const commits = git(cwd, ['rev-list', `${mergeBase}..${head}`]).split('\n').filter(Boolean);
    // A pull request that scans nothing, or not its own head, has proved nothing.
    if (pr && !commits.includes(pr.head.sha)) {
      out('leak-gate: BLOCKED. The pull request head commit is not in the scanned range.');
      return 1;
    }

    const lines = (p, n, text) => judge(`${p}:${n}`, text);
    const paths = new Set();
    // Net change, then each commit: a line added and later removed is still published.
    addedLines(git(cwd, ['diff', ...DIFF_FLAGS, mergeBase, head]), lines);
    for (const p of addedPaths(cwd, mergeBase, head)) paths.add(p);

    const strictIdentity = Boolean(pr) && !isFork;
    for (const c of commits) {
      const short = c.slice(0, 10);
      const [an, ae, cn, ce, parents, message] = git(cwd, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%P%x00%B', c]).split('\0');
      for (const [role, name, email] of [['author', an, ae], ['committer', cn, ce]]) {
        judge(`commit ${short} ${role}`, `${name} <${email}>`);
        if (strictIdentity && !SAFE_EMAIL.test(email)) findings.add(`commit ${short} ${role}: email is not a no-reply address`);
        if (strictIdentity && !SAFE_NAME.test(name)) findings.add(`commit ${short} ${role}: name is not a known public handle`);
      }
      for (const row of message.split('\n')) {
        judge(`commit ${short} message`, row);
        if (PRIVATE_MERGE.test(row)) findings.add(`commit ${short}: merges an sdk-run/* or audit/* branch`);
      }
      if (parents.trim().includes(' ')) continue; // merge commits: covered by the net change
      const patch = git(cwd, ['diff-tree', '-p', '-r', '--root', '--no-commit-id', ...DIFF_FLAGS, c]);
      addedLines(patch, (p, n, text) => judge(`commit ${short} ${p}:${n}`, text));
      for (const p of git(cwd, ['diff-tree', '-r', '--root', '--no-commit-id', '--no-renames', '--name-only', '--diff-filter=A', '-z', c]).split('\0').filter(Boolean)) paths.add(p);
    }
    for (const p of paths) {
      judge('a file path', p);
      if (isAuditPath(p, allow)) findings.add(`${p}: audit-shaped file`);
    }
    // The PR title and body can become the squash commit message.
    if (pr) for (const row of `${pr.title ?? ''}\n${pr.body ?? ''}`.split('\n')) judge('pull request title or body', row);
    out(`leak-gate: judged ${commits.length} commit(s), ${paths.size} added file(s)`);
  }

  if (findings.size === 0) { out('leak-gate: PASSED'); return 0; }
  for (const f of findings) out(`  ✗ ${f}`);
  out(`leak-gate: BLOCKED, ${findings.size} finding(s). Matched values are not shown. See .github/LEAK-GATE.md.`);
  return 1;
}

// ── self-test: synthetic values only, in a throwaway repository ─────────────
function selftest() {
  const dir = mkdtempSync(join(tmpdir(), 'leak-gate-'));
  const phrase = 'zebra canary phrase';
  const ip = ['203', '0', '113', '77'].join('.');
  const list = JSON.stringify({ entries: [
    { category: 'phrase', len: phrase.length, sha256: sha(phrase) },
    { category: 'ipv4', sha256: sha(ip) },
  ] });
  const handle = { GIT_AUTHOR_NAME: 'bigdev', GIT_AUTHOR_EMAIL: 'bigdev@users.noreply.github.com' };
  const ident = { ...process.env, ...handle, GIT_COMMITTER_NAME: handle.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: handle.GIT_AUTHOR_EMAIL };
  const g = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env: ident, encoding: 'utf8' }).trim();
  const commit = (path, body) => {
    writeFileSync(join(dir, path), body);
    g('add', '--', path);
    g('commit', '-qm', `add ${path}`);
    return g('rev-parse', 'HEAD');
  };
  let failed = 0;
  try {
    g('init', '-q', '-b', 'main');
    const base = commit('README.md', 'hello\n');
    const check = (name, want, files, env = {}, event = null) => {
      g('checkout', '-q', '--detach', base);
      let head = base;
      for (const [path, body] of files) head = commit(path, body);
      const full = { PII_BLOCKLIST_JSON: list, LEAK_GATE_BASE: base, ...env };
      if (event) {
        const file = join(dir, '.git', 'event.json');
        writeFileSync(file, JSON.stringify(event(head)));
        full.GITHUB_EVENT_PATH = file;
      }
      let got;
      try { got = run({ cwd: dir, env: full, out: () => {} }); } catch { got = 2; }
      if (got !== want) { failed++; console.log(`  ✗ ${name}: exit ${got}, wanted ${want}`); }
      else console.log(`  ✓ ${name}`);
    };
    const prFrom = (from) => (head) => ({ pull_request: { head: { sha: head, repo: { full_name: from } }, base: { repo: { full_name: 'o/r' } } } });
    const clean = [['a.txt', 'nothing here\n']];

    check('clean change passes', 0, clean);
    check('blocklisted phrase blocks', 1, [['a.txt', `x ${phrase.toUpperCase()} y\n`]]);
    check('blocklisted address blocks', 1, [['a.txt', `host ${ip}\n`]]);
    check('added then removed still blocks', 1, [['a.txt', `${phrase}\n`], ['a.txt', 'gone\n']]);
    check('home path blocks', 1, [['a.txt', ['', 'Users', 'somebody', 'x'].join('/') + '\n']]);
    check('audit-shaped file blocks', 1, [['SECURITY-AUDIT.md', 'x\n']]);
    check('allowed audit path passes', 0, [['SECURITY-AUDIT.md', 'x\n']], { LEAK_GATE_AUDIT_ALLOW: '^SECURITY-' });
    check('sdk-run branch blocks', 1, clean, { GITHUB_HEAD_REF: 'sdk-run/1' });
    check('audit branch blocks', 1, clean, { GITHUB_REF: 'refs/heads/audit/x' });
    check('no blocklist blocks', 1, clean, { PII_BLOCKLIST_JSON: '' });
    check('empty blocklist cannot run', 2, clean, { PII_BLOCKLIST_JSON: '{"entries":[]}' });
    check('own-branch PR without blocklist blocks', 1, clean, { PII_BLOCKLIST_JSON: '' }, prFrom('o/r'));
    check('fork PR without blocklist passes the other rules', 0, clean, { PII_BLOCKLIST_JSON: '' }, prFrom('x/r'));
    check('fork PR still refuses a home path', 1, [['a.txt', ['', 'Users', 'somebody', ''].join('/') + '\n']], { PII_BLOCKLIST_JSON: '' }, prFrom('x/r'));
    check('personal commit email on own branch blocks', 1, [], {}, () => {
      ident.GIT_AUTHOR_EMAIL = 'someone@example.com';
      const next = commit('b.txt', 'x\n');
      ident.GIT_AUTHOR_EMAIL = handle.GIT_AUTHOR_EMAIL;
      return prFrom('o/r')(next);
    });
    check('PR head outside the range blocks', 1, clean, {}, () => prFrom('o/r')('0'.repeat(40)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `leak-gate self-test: ${failed} FAILED` : 'leak-gate self-test: PASSED');
  return failed ? 1 : 0;
}

if (process.argv[1] === SELF) {
  try {
    process.exitCode = process.argv.includes('--selftest')
      ? selftest()
      : run({ cwd: process.cwd(), env: process.env, tree: process.argv.includes('--tree') });
  } catch (err) {
    // First line only: git's stderr can quote content.
    console.log(`leak-gate: could not run (${String(err.message).split('\n')[0]})`);
    process.exitCode = 2;
  }
}
