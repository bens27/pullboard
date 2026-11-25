/** @pullboard-test-input source-tree */
/**
 * Tracked files and pushed commit bodies never quote the owner or name private infrastructure (#895): the owner's
 * machines by name, this machine's host name, its private network addresses, or this user's home folder. Published
 * history is not rewritten; the commit check reads only the range a push would send.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { hostname } from 'node:os';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
/** The files that hold these patterns to test them; every other tracked file is scanned. */
const PATTERN_HOLDERS = new Set(['test/privacy-words.test.js', 'docs/privacy.test.js', 'test/cockpit/privacy-scan.test.js']);
/** Placeholder home folders that tests plant on purpose to prove redaction. */
const PLACEHOLDER_HOMES = new Set(['private', 'example', 'person', 'user', 'me', 'you', 'name']);
/** The one exact container-home declaration that is not a host user's home path. */
const CONTAINER_HOME_DECLARATION = "const SANDBOX_CONTAINER_HOME = '/home/sandbox';";
const MACHINES = ['Stu' + 'dio', 'Mac' + 'Book', 'M' + 'BP'];

/** Escape text for a regular expression. */
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Host names that are ordinary words or vendor defaults. They name no one, so they are not private, and as a search
 * pattern they would match ordinary prose ("Mac" is in hundreds of tracked lines).
 */
const GENERIC_HOSTS = new Set(['localhost', 'mac', 'imac', 'macmini', 'host', 'server', 'desktop', 'laptop', 'computer',
  'pc', 'workstation', 'ubuntu', 'debian', 'fedora', 'linux', 'raspberrypi', 'runner', 'box', 'node', 'machine']);

/**
 * This machine's own name. On macOS that is `scutil --get LocalHostName`: os.hostname() there falls back to whatever
 * name the current network hands out by reverse DNS (for example "Mac.<isp>.com"), so it changes with the network and
 * is often a common word. Elsewhere, or when scutil fails or prints nothing, os.hostname().
 *
 * @param {{ platform?: string, localHostName?: () => string, osHostname?: () => string }} [sources] - stand-ins for tests
 * @returns {string}
 */
function machineName({ platform = process.platform, localHostName = scutilLocalHostName, osHostname = hostname } = {}) {
  if (platform === 'darwin') {
    try {
      const name = localHostName().trim();
      if (name) return name;
    } catch { /* scutil missing or slow: fall back below */ }
  }
  return osHostname();
}

/** The macOS LocalHostName, read with a short timeout so a stalled scutil cannot hang the test. */
function scutilLocalHostName() {
  return execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * The 'this host name' rule for a host, or none. The short name (before the first dot) becomes a whole-word pattern
 * when it is distinctive. A short name under 3 characters or in GENERIC_HOSTS gets no rule: a common word is not a
 * private name, and searching for it would report every ordinary use. Every other name keeps its rule, so a
 * distinctive name is never dropped; only that fixed list of common words is.
 *
 * @param {string} host
 * @returns {{ name: string, pattern: RegExp }[]}
 */
function hostRule(host) {
  const short = host.split('.')[0];
  if (short.length < 3 || GENERIC_HOSTS.has(short.toLowerCase())) return [];
  return [{ name: 'this host name', pattern: new RegExp(`\\b${literal(short)}\\b`, 'iu') }];
}

/**
 * The rules, built for this machine: what counts as a quote of the owner, a machine name, this host's name, one of
 * its private network addresses, or this user's home folder.
 *
 * @param {{ host?: string, addresses?: string[], home?: string }} [machine] - stand-ins for tests
 */
function rules({ host = machineName(), addresses = privateAddresses(), home = homedir() } = {}) {
  return [
    { name: 'an owner quote', pattern: /\b[Tt]he person, \d{1,2} [A-Z][a-z]{2}\b/u },
    { name: 'a private machine name', pattern: new RegExp(`\\b(?:${MACHINES.join('|')})\\b`, 'u') },
    ...hostRule(host),
    ...addresses.map((address) => ({ name: 'a private network address of this machine', pattern: new RegExp(`(?<![\\d.])${literal(address)}(?![\\d])`, 'u') })),
    { name: 'a home folder', pattern: new RegExp(`(?:${literal(home)}|/(?:Users|home)/(?!(?:${[...PLACEHOLDER_HOMES].join('|')})\\b)[A-Za-z][\\w.-]*)(?=/|\\b)`, 'u') },
  ];
}

/** This machine's addresses in the private ranges (10/8, 172.16/12, 192.168/16). */
function privateAddresses() {
  return Object.values(networkInterfaces()).flat().filter(Boolean).map((entry) => entry.address)
    .filter((address) => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(address));
}

/** Every rule a text breaks, as "<where>: <rule>". */
function problemsIn(text, where, active) {
  return active.filter((rule) => rule.pattern.test(text)).map((rule) => `${where}: ${rule.name}`);
}

/** Recognize only the declared sandbox container-home constant, never other uses of that path. */
function isContainerHomeDeclaration(path, line) {
  return path === 'src/sandbox-verify.js' && line === CONTAINER_HOME_DECLARATION;
}

/**
 * The privacy problems in a repository: each tracked text file, and each commit body in the range a push would send.
 *
 * @param {string} root
 * @param {{ range?: string|null, machine?: object }} [options] - the commit range; null skips commits
 * @returns {string[]}
 */
function privacyProblems(root, { range = pushedRange(root), machine } = {}) {
  const active = rules(machine);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const problems = [];
  for (const path of git('ls-files', '-z').split('\0').filter(Boolean)) {
    if (PATTERN_HOLDERS.has(path) || /\.(?:png|jpe?g|gif|ico|woff2?|ttf|mp4|webm|sqlite|pdf)$/iu.test(path)) continue;
    let text;
    try { text = readFileSync(join(root, path), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, index) => {
      if (isContainerHomeDeclaration(path, line)) return;
      problems.push(...problemsIn(line, `${path}:${index + 1}`, active));
    });
  }
  if (range) {
    for (const record of git('log', '--format=%H%x00%b%x1e', range).split('\x1e').map((entry) => entry.trim()).filter(Boolean)) {
      const [sha, body] = record.split('\0');
      problems.push(...problemsIn(body ?? '', `commit ${sha.slice(0, 12)} body`, active));
    }
  }
  return problems;
}

/** The commits a push would send: those not yet on the upstream branch, or none when there is no upstream. */
function pushedRange(root) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '-q', '@{upstream}'], { cwd: root, stdio: 'ignore' });
    return '@{upstream}..HEAD';
  } catch { return null; }
}

/** A disposable repository with one committed file and one commit body. */
function planted(t, { file = 'clean text\n', filePath = 'notes.md', body = 'Pullboard-Item: #1' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-privacy-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Privacy Fixture', GIT_AUTHOR_EMAIL: 'privacy@example.invalid', GIT_COMMITTER_NAME: 'Privacy Fixture', GIT_COMMITTER_EMAIL: 'privacy@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'chore: start');
  const base = git('rev-parse', 'HEAD').trim();
  mkdirSync(dirname(join(root, filePath)), { recursive: true });
  writeFileSync(join(root, filePath), file);
  git('add', filePath);
  git('commit', '-q', '-m', 'docs: add notes', '-m', body);
  return { root, range: `${base}..HEAD` };
}

const STAND_IN = { host: 'workbench-7.lan', addresses: ['10.11.12.13'], home: '/Users/fixture-owner' };

test('tracked files and pushed commit bodies carry no owner quote or private infrastructure [C7]', () => {
  assert.deepEqual(privacyProblems(ROOT), [], 'every finding names the file and line, or the commit, to fix');
});

test('each privacy rule refuses a planted case in a tracked file and in a commit body [C7]', (t) => {
  const cases = [
    ['an owner quote', 'as decided (the person, 18 Oct), ship it'],
    ['a private machine name', `the gate ran on the ${MACHINES[0]} overnight`],
    ['this host name', 'logs from workbench-7 show the stall'],
    ['a private network address of this machine', 'ssh to 10.11.12.13 and rerun'],
    ['a home folder', 'see /Users/fixture-owner/Code/repo for the log'],
  ];
  for (const [rule, text] of cases) {
    const filePath = rule === 'a home folder' ? 'src/privacy-probe.js' : 'notes.md';
    const inFile = planted(t, { file: `${text}\n`, filePath });
    assert.deepEqual(privacyProblems(inFile.root, { range: inFile.range, machine: STAND_IN }), [`${filePath}:1: ${rule}`], `a tracked file with ${rule}`);
    const inBody = planted(t, { body: `${text}\n\nPullboard-Item: #1` });
    const found = privacyProblems(inBody.root, { range: inBody.range, machine: STAND_IN });
    assert.equal(found.length, 1, `a commit body with ${rule}: ${found.join('; ')}`);
    assert.match(found[0], new RegExp(`^commit [0-9a-f]{12} body: ${literal(rule)}$`, 'u'));
  }
  const clean = planted(t, { file: 'SSH_CONNECTION=10.0.0.1 22 and /Users/private/project are placeholders\n' });
  assert.deepEqual(privacyProblems(clean.root, { range: clean.range, machine: STAND_IN }), [], 'placeholders and addresses of no machine pass');
});

test('the host rule uses the machine\'s own name, not a network-assigned one, and never a common word [C7]', (t) => {
  const network = () => 'Mac.phub.net.cable.rogers.com';
  const own = machineName({ platform: 'darwin', localHostName: () => 'workbench-7\n', osHostname: network });
  assert.equal(own, 'workbench-7', 'on macOS the LocalHostName wins over the reverse-DNS name');
  assert.equal(machineName({ platform: 'darwin', localHostName: () => { throw new Error('no scutil'); }, osHostname: network }), network(), 'a failed scutil falls back');
  assert.equal(machineName({ platform: 'darwin', localHostName: () => '  \n', osHostname: network }), network(), 'an empty LocalHostName falls back');
  assert.equal(machineName({ platform: 'linux', localHostName: () => 'unused', osHostname: () => 'workbench-7.lan' }), 'workbench-7.lan', 'elsewhere os.hostname()');
  const prose = planted(t, { file: 'runs on Mac and Linux\n', body: 'tested on a Mac\n\nPullboard-Item: #1' });
  const machine = { ...STAND_IN, host: own };
  assert.deepEqual(privacyProblems(prose.root, { range: prose.range, machine }), [], 'the network name\'s word Mac is not searched for');
  const named = planted(t, { file: 'logs from workbench-7 show the stall\n' });
  assert.deepEqual(privacyProblems(named.root, { range: named.range, machine }), ['notes.md:1: this host name'], 'the own name is still searched for');
  assert.deepEqual(hostRule('Mac.phub.net.cable.rogers.com'), [], 'a common word gets no rule even when it is the only name');
  assert.equal(hostRule('workbench-7.local').length, 1, 'a distinctive name keeps its rule');
});

test('only the declared sandbox container home is exempted while a real source home is still caught [C7]', (t) => {
  const source = readFileSync(join(ROOT, 'src/sandbox-verify.js'), 'utf8');
  const declarations = source.split('\n').filter(line => isContainerHomeDeclaration('src/sandbox-verify.js', line));
  assert.equal(declarations.length, 1, 'the container home is declared exactly once');
  const realHome = planted(t, { file: "const privatePath = '/Users/fixture-owner/project';\n", filePath: 'src/privacy-probe.js' });
  assert.deepEqual(privacyProblems(realHome.root, { range: realHome.range, machine: STAND_IN }),
    ['src/privacy-probe.js:1: a home folder'], 'the narrow sandbox allowance does not suppress a real home path in source');
});
