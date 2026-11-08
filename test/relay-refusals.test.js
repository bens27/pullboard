/** Kept relay replay refusals: relay on tells each once by a told cursor; status shows every kept one [H21,B26]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { keepRefusal } from '../src/relay-outbox.js';
import { REFUSAL_CAP, REFUSAL_DAYS } from '../src/relay-refusals.js';
import { startFixtureChild } from './fixture-child.js';
import { relayClientFixture } from './relay-client-fixture.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');
const DAY = 24 * 60 * 60 * 1000;
const REFUSED = /\[RELAY_OUTBOX_REFUSED\] the queued move /gu;

/** Record refusals as keepRefusal does, one per item, on `state` (a fresh one by default), and return them. */
function refusalsOn(items, state = {}) {
  for (const item of items) {
    keepRefusal(state, { move: { operation: 'verify', args: [item], actor: 'review-2' }, queuedAt: '2026-11-06T10:00:00.000Z' },
      { code: 'VERIFIER_STANDING', message: `synthetic refusal of #${item}` }, []);
  }
  return state.outboxRefusals;
}

/** The linked board's relay.json as saved. */
function linkOf(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Only the refusal fields of a saved link: the entries, their counter and the told cursor. */
function refusalFields(file) {
  const { outboxRefusals, outboxRefusalSeq, outboxRefusalsTold } = linkOf(file);
  return { outboxRefusals, outboxRefusalSeq, outboxRefusalsTold };
}

/** Seed a link's refusal fields as a replay that lost, and an earlier relay on, would have left them. */
function seedLink(file, fields) {
  writeFileSync(file, JSON.stringify({ ...linkOf(file), ...fields }) + '\n', { mode: 0o600 });
}

/** Run the production CLI in plain words and return its exit code and output. */
function plain(t, box, ...args) {
  const child = startFixtureChild(process.execPath, [CLI, ...args], { cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
  const done = new Promise((finish) => child.once('close', finish));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await done; });
  return done.then(code => ({ code, stdout, stderr }));
}

/**
 * Run relay on --all on the linked board until its pairing wait, cancel the pairing, and return its exit code and output.
 */
async function relayOnAll(t, box, ...extra) {
  const child = startFixtureChild(process.execPath, [CLI, 'relay', 'on', '--all', '--url', box.origin, ...extra],
    { cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
  const done = new Promise((finish) => child.once('close', finish));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await done; });
  const deadline = Date.now() + 20_000; // budget: hang ceiling for the loopback sign-in, the links and the first pairing poll.
  while (!box.calls.some(call => call.method === 'GET' && call.path.startsWith('/api/v1/devices/enrollments/'))) {
    assert.ok(Date.now() < deadline && child.exitCode === null, `relay on --all reaches its pairing wait\n${stdout}\n${stderr}`);
    await new Promise(wait => setTimeout(wait, 25));
  }
  child.kill('SIGINT');
  return { code: await done, stdout, stderr };
}

/** Seed refusal fields into an additional board's relay.json from inside its own home. */
async function seedOther(other, fields) {
  const run = await other.script(`
    import { readFileSync, writeFileSync } from 'node:fs';
    const file = '.git/pullboard/relay.json';
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...${JSON.stringify(fields)} }) + '\\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ seeded: true }));
  `);
  assert.equal(run.code, 0, run.failure);
}

/** An additional board's saved refusal fields, read from inside its own home. */
async function otherFields(other) {
  const run = await other.script(`
    import { readFileSync } from 'node:fs';
    const { outboxRefusals, outboxRefusalSeq, outboxRefusalsTold } = JSON.parse(readFileSync('.git/pullboard/relay.json', 'utf8'));
    process.stdout.write(JSON.stringify({ outboxRefusals, outboxRefusalSeq, outboxRefusalsTold }));
  `);
  assert.equal(run.code, 0, run.failure);
  return run.document;
}

test('relay on tells a kept refusal once, then is quiet on the next run [H21,B26]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const refused = refusalsOn([1]);
  seedLink(box.linkFile, { outboxRefusals: refused });

  const first = await plain(t, box, 'relay', 'on', '--url', box.origin);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout.match(REFUSED)?.length, 1, 'the first relay on tells the refusal');
  assert.equal(linkOf(box.linkFile).outboxRefusalsTold, 1, 'and moves the told cursor past it');
  const second = await plain(t, box, 'relay', 'on', '--url', box.origin);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout.match(REFUSED), null, 'the next relay on does not repeat it');
  assert.equal(linkOf(box.linkFile).outboxRefusalsTold, 1, 'the cursor stays');
  assert.deepEqual(linkOf(box.linkFile).outboxRefusals, refused, 'telling it deletes nothing');
});

test('a refusal kept after a told one is told alone [H21,B26]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  seedLink(box.linkFile, { outboxRefusals: refusalsOn([1]) });
  const first = await box.cli('relay', 'on', '--url', box.origin);
  assert.equal(first.code, 0, first.failure);
  assert.equal(first.document.outboxRefusals.length, 1, 'the first relay on tells the first refusal');
  assert.equal(linkOf(box.linkFile).outboxRefusalsTold, 1);

  const state = linkOf(box.linkFile);
  refusalsOn([2], state);
  writeFileSync(box.linkFile, JSON.stringify(state) + '\n', { mode: 0o600 });
  const later = state.outboxRefusals.at(-1);
  assert.equal(later.seq, 2, 'the new refusal takes the next number');
  const second = await box.cli('relay', 'on', '--url', box.origin);
  assert.equal(second.code, 0, second.failure);
  assert.deepEqual(second.document.outboxRefusals, [later], 'only the new refusal is told');
  assert.equal(linkOf(box.linkFile).outboxRefusalsTold, 2, 'the cursor moves past it');
});

test('relay status and pullboard status write no refusal fields and show every kept refusal [H21,B26]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const refused = refusalsOn([1, 2, 3, 4, 5, 6, 7]);
  seedLink(box.linkFile, { outboxRefusals: refused, outboxRefusalSeq: 7, outboxRefusalsTold: 3 });
  const saved = refusalFields(box.linkFile);

  for (const args of [['status'], ['relay', 'status']]) {
    const json = await box.cli(...args);
    assert.equal(json.code, 0, json.failure);
    const shown = args[0] === 'status' ? json.document.relay.outboxRefusals : json.document.outboxRefusals;
    assert.deepEqual(shown, refused, `${args.join(' ')} --json names every kept refusal, told or not`);
    const text = await plain(t, box, ...args);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /relay outbox: 7 replay refusals kept; the newest 5:/u, `${args.join(' ')} says how many are kept`);
    assert.equal(text.stdout.match(REFUSED)?.length, 5, `${args.join(' ')} prints the newest five`);
    assert.ok(text.stdout.includes('synthetic refusal of #7') && !text.stdout.includes('synthetic refusal of #2;'), 'the newest, not the oldest');
    assert.deepEqual(refusalFields(box.linkFile), saved, `${args.join(' ')} writes no refusal or cursor field`);
  }
});

test('a kept refusal is pruned after 30 days and past 200 kept [H21,B26]', () => {
  assert.equal(REFUSAL_DAYS, 30);
  assert.equal(REFUSAL_CAP, 200);
  const now = Date.now();
  const state = {};
  refusalsOn([1, 2], state);
  state.outboxRefusals[0].at = new Date(now - (REFUSAL_DAYS + 1) * DAY).toISOString();
  state.outboxRefusals[1].at = new Date(now - (REFUSAL_DAYS - 1) * DAY).toISOString();
  // Saved before stamps: its queued time stands in for when it was kept.
  state.outboxRefusals.push({ move: 'verify #9 by review-2', queuedAt: new Date(now - (REFUSAL_DAYS + 2) * DAY).toISOString(), code: 'X', message: 'old', earlier: [] });
  refusalsOn([3], state);
  assert.deepEqual(state.outboxRefusals.map(kept => kept.message), ['synthetic refusal of #2', 'synthetic refusal of #3'],
    'refusals older than 30 days go when the next is kept; younger ones stay');
  assert.equal(state.outboxRefusals.at(-1).seq, 4, 'numbers never go back, even for pruned entries');

  const full = {};
  refusalsOn(Array.from({ length: REFUSAL_CAP }, (_, index) => index + 1), full);
  assert.equal(full.outboxRefusals.length, REFUSAL_CAP);
  refusalsOn([REFUSAL_CAP + 1], full);
  assert.equal(full.outboxRefusals.length, REFUSAL_CAP, 'the cap holds');
  assert.equal(full.outboxRefusals[0].seq, 2, 'the oldest goes first');
  assert.equal(full.outboxRefusals.at(-1).seq, REFUSAL_CAP + 1);
  assert.equal(full.outboxRefusalSeq, REFUSAL_CAP + 1);
});

test('refusals saved before numbering count as untold, numbered in order, and status writes none [H21,B26]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const legacy = refusalsOn([1, 2, 3]).map(({ seq: _seq, at: _at, ...rest }) => rest);
  seedLink(box.linkFile, { outboxRefusals: legacy });
  const before = refusalFields(box.linkFile);
  const status = await box.cli('status');
  assert.equal(status.code, 0, status.failure);
  assert.deepEqual(status.document.relay.outboxRefusals.map(kept => kept.seq), [1, 2, 3], 'status numbers them in order');
  assert.deepEqual(refusalFields(box.linkFile), before, 'status saves no number, counter or cursor');

  const on = await box.cli('relay', 'on', '--url', box.origin);
  assert.equal(on.code, 0, on.failure);
  assert.deepEqual(on.document.outboxRefusals.map(kept => kept.message), legacy.map(kept => kept.message), 'relay on tells every one of them');
  const saved = linkOf(box.linkFile);
  assert.deepEqual(saved.outboxRefusals.map(kept => kept.seq), [1, 2, 3], 'the told path saves their numbers');
  assert.equal(saved.outboxRefusalsTold, 3);

  // A counter ahead of the entries, as after a prune, numbers the unnumbered after it.
  const mixed = { outboxRefusalSeq: 4, outboxRefusals: structuredClone(legacy.slice(0, 2)) };
  refusalsOn([4], mixed);
  assert.deepEqual(mixed.outboxRefusals.map(kept => kept.seq), [5, 6, 7], 'unnumbered entries take the next numbers in order, then the new one');
});

test('relay on --all --json lists each board\'s newly told refusals [H21,B26]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const mine = refusalsOn([1, 2]);
  seedLink(box.linkFile, { outboxRefusals: mine, outboxRefusalsTold: 1 });
  const other = await box.additionalBoard('second board', { sharedHome: true });
  const theirs = refusalsOn([5]);
  await seedOther(other, { outboxRefusals: theirs });

  const { code, stdout, stderr } = await relayOnAll(t, box, '--json');
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  const document = JSON.parse(stdout);
  const byBoard = Object.fromEntries(document.linked.map(board => [board.board, board.outboxRefusals]));
  assert.deepEqual(byBoard[linkOf(box.linkFile).board], [mine[1]], 'this board lists only its untold refusal');
  assert.deepEqual(byBoard[other.id], theirs, 'the other board lists its own');
  assert.equal(linkOf(box.linkFile).outboxRefusalsTold, 2, 'this board\'s cursor moves past what the document listed');
  assert.equal((await otherFields(other)).outboxRefusalsTold, 1, 'and the other board\'s');
});

test('a partial relay on --all, stopped while a board waits for its phone, moves only the printed boards\' cursors [H21,B26]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const mine = refusalsOn([1]);
  seedLink(box.linkFile, { outboxRefusals: mine });
  // A board whose baseline is paused for size, on a relay without the paged snapshot API: it links, complete:false.
  const paused = await box.additionalBoard('paused board', { sharedHome: true });
  const pausedRefusals = refusalsOn([2]);
  await seedOther(paused, { outboxRefusals: pausedRefusals, baselinePause: { code: 'SNAPSHOT_TOO_LARGE', message: 'snapshot exceeds the size limit' } });
  box.legacySnapshotApi(true);
  const broken = join(box.root, '..', 'not-a-board');
  mkdirSync(broken);
  const waitingRefusals = refusalsOn([3]);
  const module = name => JSON.stringify(resolve(import.meta.dirname, '../src/' + name));
  const fixtureModule = JSON.stringify(resolve(import.meta.dirname, 'fixture-child.js'));
  const run = await box.script(`
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { main } from ${module('cli-main.js')};
import { registerProject } from ${module('projects.js')};
import { readRelayMachine, updateRelayMachine } from ${module('relay-machine.js')};
import { runFixtureGit } from ${fixtureModule};
const root = ${JSON.stringify(box.root)};
const link = JSON.parse(readFileSync(${JSON.stringify(box.linkFile)}, 'utf8'));
const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
updateRelayMachine(state => {
  state.autoLink = true;
  state.owner = { account: link.account, url: link.url };
  state.devices.push({ deviceId: 'device-' + 'a'.repeat(32), account: link.account, url: link.url, fingerprint: 'b'.repeat(64),
    label: 'Kitchen phone', createdAt: new Date().toISOString(), publicKey: { kty, crv, x, y } });
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const address = new URL(input instanceof Request ? input.url : input);
  // The stand-in phone never answers, so the link request stays pending.
  if (address.pathname.startsWith('/api/v1/devices/')) {
    const body = address.pathname === '/api/v1/devices/approvals' ? { version: 1 } : { version: 1, approval: { state: 'pending' } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return originalFetch(input, options);
};
const quiet = { cwd: root, stdin: process.stdin, stdout: { isTTY: false, write() {} }, stderr: { write() {} } };
const other = join(dirname(root), 'waiting-board');
mkdirSync(other);
for (const args of [['init','-q','-b','main'], ['-c','commit.gpgsign=false','commit','--allow-empty','-q','-m','chore: waiting board'],
  ['remote','add','origin','git@github.com:fixture/repository-9.git']]) runFixtureGit(args, { cwd: other, env: process.env });
const initCode = await main(['init'], { ...quiet, cwd: other });
const waitingFile = join(other, '.git', 'pullboard', 'relay.json');
const hadLink = existsSync(waitingFile);
// The waiting board kept a refusal from an earlier link; only a printed one may move its cursor.
writeFileSync(waitingFile, JSON.stringify({ ...(hadLink ? JSON.parse(readFileSync(waitingFile, 'utf8')) : link), outboxRefusals: ${JSON.stringify(waitingRefusals)} }) + '\\n', { mode: 0o600 });
registerProject(${JSON.stringify(broken)}, new Date(Date.now() + 60_000));
const pending = readRelayMachine().approvals.filter(entry => entry.root.endsWith('waiting-board')).length;
let output = '';
let errors = '';
let interrupted = false;
const streams = { cwd: root, stdin: process.stdin,
  stdout: { isTTY: false, write: part => {
    output += part;
    if (!interrupted && output.includes('waiting for phone approval:')) { interrupted = true; setTimeout(() => process.emit('SIGINT'), 50); }
  } },
  stderr: { write: part => { errors += part; } } };
const code = await main(['relay', 'on', '--all', '--url', ${JSON.stringify(box.origin)}], streams);
globalThis.fetch = originalFetch;
const waitingFields = JSON.parse(readFileSync(waitingFile, 'utf8'));
process.stdout.write(JSON.stringify({ initCode, hadLink, pending, code, interrupted, output, errors,
  waiting: { outboxRefusals: waitingFields.outboxRefusals, outboxRefusalsTold: waitingFields.outboxRefusalsTold } }));
process.exit(0);
`);
  assert.equal(run.code, 0, run.failure);
  const { initCode, pending, code, interrupted, output, errors, waiting } = run.document;
  assert.equal(initCode, 0, 'the waiting board initializes');
  assert.equal(pending, 1, 'its link waits for the phone');
  assert.ok(interrupted, `relay on --all reached the approval wait\n${output}\n${errors}`);
  assert.equal(code, 1, `the broken board fails the run\n${output}\n${errors}`);
  assert.match(output, /Linked 2 of 4 registered boards\./u, `the real and paused boards linked; the broken one failed and one waits\n${output}`);
  assert.match(output, /stopped waiting for phone approval: waiting-board/u, 'the run stopped with the board still waiting');
  assert.equal(output.match(REFUSED)?.length, 2, 'the two linked boards each told their refusal');
  assert.ok(!output.includes('synthetic refusal of #3'), 'the waiting board told nothing');

  assert.deepEqual(linkOf(box.linkFile).outboxRefusals, mine, 'no board loses a refusal');
  assert.equal(linkOf(box.linkFile).outboxRefusalsTold, 1, 'the board that printed moves its cursor');
  const pausedNow = await otherFields(paused);
  assert.deepEqual(pausedNow.outboxRefusals, pausedRefusals);
  assert.equal(pausedNow.outboxRefusalsTold, 1, 'a board that linked complete:false still printed, so it moves too');
  assert.deepEqual(waiting.outboxRefusals, waitingRefusals, 'the waiting board keeps its refusal');
  assert.equal(waiting.outboxRefusalsTold, undefined, 'and its cursor never moves');
});
