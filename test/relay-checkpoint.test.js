/** @pullboard-test-input source-tree */
/** A move sends only its own event; one background publisher sends the checkpoint once moves go quiet [H5]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from './relay-client-fixture.js';
import { CHECKPOINT_BACKGROUND_ENV, CHECKPOINT_QUIET_ENV, presentationInputs, requestCheckpointCheck } from '../src/relay-checkpoint.js';

/** Whether a relay call uploads a checkpoint: an API1 state write or an API2 page publish. */
function checkpointUpload(call) {
  return call.method === 'PUT' && /^\/api\/v1\/boards\/[0-9a-f]{32}\/state$/u.test(call.path ?? '')
    || call.method === 'POST' && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads\/[^/]+\/publish$/u.test(call.path ?? '');
}

/** Wait until the background publisher has uploaded at least `uploads` checkpoints since `from` and finished. */
async function publisherDone(box, from, uploads) {
  const directory = dirname(box.linkFile);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (box.calls.slice(from).filter(checkpointUpload).length >= uploads && !existsSync(join(directory, 'relay-checkpoint.pid'))) return;
    await new Promise(next => setTimeout(next, 100));
  }
  const log = join(directory, 'relay-checkpoint.log');
  const seen = ['relay-checkpoint.due', 'relay-checkpoint.pid'].filter(name => existsSync(join(directory, name)));
  const settings = Object.keys(box.env).filter(name => /^PULLBOARD_RELAY|^NODE_OPTIONS$|^CI$/u.test(name));
  assert.fail(`the background publisher sent no checkpoint: ${existsSync(log) ? readFileSync(log, 'utf8') : 'no publisher log'}; files: ${seen.join(', ') || 'none'}; child settings named: ${settings.join(', ') || 'none'}`);
}

test('a move on a large board sends only its event and never the checkpoint [H5]', async (t) => {
  // The runner keeps checkpoints inside commands, like the view; this case opts in to the background publisher.
  const inline = process.env[CHECKPOINT_BACKGROUND_ENV];
  delete process.env[CHECKPOINT_BACKGROUND_ENV];
  // A CLI child takes about a second to start, so a burst of them is modelled as moves under three seconds apart.
  process.env[CHECKPOINT_QUIET_ENV] = '3000';
  t.after(() => {
    if (inline === undefined) delete process.env[CHECKPOINT_BACKGROUND_ENV]; else process.env[CHECKPOINT_BACKGROUND_ENV] = inline;
    delete process.env[CHECKPOINT_QUIET_ENV];
  });
  const box = await relayClientFixture(t);

  // Seed the presentation's heaviest part, as on the 22 Oct board: 20,000 shouts.
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  const insert = db.prepare('INSERT INTO shout(shout_from, shout_to, shout_text, shout_at) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let index = 0; index < 20_000; index += 1) insert.run('coordinator', 'all', `seeded shout ${index} with some ordinary words in it`, new Date(Date.UTC(2026, 9, 22, 0, 0, index % 60)).toISOString());
  db.exec('COMMIT');
  db.close();
  await box.link();

  // One move, then let its checkpoint go out, so the burst below starts from a covered board.
  const warm = box.calls.length;
  assert.equal((await box.cli('shout', 'all', 'warm up')).code, 0);
  await publisherDone(box, warm, 1);

  const before = box.calls.length;
  for (let index = 1; index <= 10; index += 1) {
    const from = box.calls.length;
    const started = performance.now();
    const moved = await box.cli('shout', 'all', `burst ${index}`);
    const elapsed = performance.now() - started;
    assert.equal(moved.code, 0, JSON.stringify(moved.document));
    const sent = box.calls.slice(from);
    assert.equal(sent.filter(checkpointUpload).length, 0, `move ${index} uploaded no checkpoint`);
    const bytes = sent.reduce((total, call) => total + (call.requestBytes ?? 0), 0);
    assert.ok(bytes < 64 * 1024, `move ${index} sent ${bytes} bytes, under 64 KB`);
    assert.ok(elapsed < 1000, `move ${index} returned in ${Math.round(elapsed)} ms, under one second`); // budget: declared by #1014's bar: a move returns in under one second.
  }
  await publisherDone(box, before, 1);
  await new Promise(next => setTimeout(next, 4_000)); // budget: a second quiet period, so a second upload would show.
  assert.equal(box.calls.slice(before).filter(checkpointUpload).length, 1, 'ten moves in a burst produced one checkpoint upload');
});

test('a move during a held checkpoint upload returns before the upload ends [H5]', async (t) => {
  const inline = process.env[CHECKPOINT_BACKGROUND_ENV];
  delete process.env[CHECKPOINT_BACKGROUND_ENV];
  t.after(() => { if (inline === undefined) delete process.env[CHECKPOINT_BACKGROUND_ENV]; else process.env[CHECKPOINT_BACKGROUND_ENV] = inline; });
  const box = await relayClientFixture(t);
  await box.link();
  const warm = box.calls.length;
  assert.equal((await box.cli('shout', 'all', 'warm up')).code, 0);
  await publisherDone(box, warm, 1);

  // The relay holds the next checkpoint upload; a move meanwhile must not wait for it.
  box.holdPublishes(true);
  t.after(() => box.holdPublishes(false));
  const from = box.calls.length;
  assert.equal((await box.cli('shout', 'all', 'starts the held upload')).code, 0);
  const deadline = Date.now() + 15_000;
  while (box.heldPublishes() === 0 && Date.now() < deadline) await new Promise(next => setTimeout(next, 50));
  assert.equal(box.heldPublishes(), 1, 'the publisher\'s upload is in flight and held');
  const started = performance.now();
  const moved = await box.cli('shout', 'all', 'moves during the held upload');
  const elapsed = performance.now() - started;
  assert.equal(moved.code, 0, JSON.stringify(moved.document));
  assert.equal(box.heldPublishes(), 1, 'the move returned while the upload was still held');
  assert.ok(elapsed < 2000, `the move took ${Math.round(elapsed)} ms; it must not wait for the upload`); // budget: ceiling for one CLI move with headroom, far under the held upload.
  box.holdPublishes(false);
  await publisherDone(box, from, 2);
});

test('publishers that find a dead holder\'s claim together upload one checkpoint between them [H5]', async (t) => {
  const inline = process.env[CHECKPOINT_BACKGROUND_ENV];
  process.env[CHECKPOINT_BACKGROUND_ENV] = '0'; // This case starts its publishers itself.
  t.after(() => { if (inline === undefined) delete process.env[CHECKPOINT_BACKGROUND_ENV]; else process.env[CHECKPOINT_BACKGROUND_ENV] = inline; });
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cli('shout', 'all', 'a move whose checkpoint is due')).code, 0);
  const directory = dirname(box.linkFile);
  // A claim left by a publisher that died, and a move older than the quiet period.
  writeFileSync(join(directory, 'relay-checkpoint.pid'), '999999\n');
  writeFileSync(join(directory, 'relay-checkpoint.due'), `${Date.now() - 60_000}\n`);
  const from = box.calls.length;
  const worker = fileURLToPath(new URL('../src/relay-checkpoint-worker.js', import.meta.url));
  const exits = Array.from({ length: 4 }, () => new Promise(done => {
    spawn(process.execPath, [worker, box.root, box.linkFile], { cwd: box.root, env: box.env, stdio: 'ignore' }).once('exit', done);
  }));
  await Promise.all(exits);
  assert.equal(box.calls.slice(from).filter(checkpointUpload).length, 1, 'four publishers recovering one dead claim sent one checkpoint');
  assert.equal(existsSync(join(directory, 'relay-checkpoint.pid')), false, 'the claim is released');
});

test('a spec edit with no move reaches the next checkpoint, and an idle command uploads none [H5,H16]', async (t) => {
  const inline = process.env[CHECKPOINT_BACKGROUND_ENV];
  delete process.env[CHECKPOINT_BACKGROUND_ENV];
  t.after(() => { if (inline === undefined) delete process.env[CHECKPOINT_BACKGROUND_ENV]; else process.env[CHECKPOINT_BACKGROUND_ENV] = inline; });
  const box = await relayClientFixture(t);
  await box.link();
  const warm = box.calls.length;
  assert.equal((await box.cli('shout', 'all', 'warm up')).code, 0);
  await publisherDone(box, warm, 1);

  // Nothing changed: the publisher reads the board, finds the page the relay already has, and uploads nothing.
  const idle = box.calls.length;
  assert.equal((await box.cli('status')).code, 0);
  await new Promise(next => setTimeout(next, 4_000)); // budget: declared quiet period plus a read, so an upload would show.
  assert.equal(box.calls.slice(idle).filter(checkpointUpload).length, 0, 'an idle command re-sent no unchanged page');

  // A draft spec row changes only the presentation; the next command's check sends it within a few seconds.
  writeFileSync(join(box.root, 'SPEC.md'), '# Checkpoint fixture spec\n\n## G · Goals\n\n- G1 [draft, must] SPEC_ONLY_CHECKPOINT_1014 | gate: review\n');
  const edited = box.calls.length;
  const started = Date.now();
  assert.equal((await box.cli('status')).code, 0);
  await publisherDone(box, edited, 1);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `the spec edit reached a checkpoint in ${elapsed} ms`); // budget: ceiling from the review: a presentation-only change goes out within five seconds.
});

test('repeated syncs on an unchanged board ask the publisher once, and a spec edit still asks [C7]', async (t) => {
  const inline = process.env[CHECKPOINT_BACKGROUND_ENV];
  delete process.env[CHECKPOINT_BACKGROUND_ENV];
  t.after(() => { if (inline === undefined) delete process.env[CHECKPOINT_BACKGROUND_ENV]; else process.env[CHECKPOINT_BACKGROUND_ENV] = inline; });
  const box = await relayClientFixture(t);
  await box.link();
  const warm = box.calls.length;
  assert.equal((await box.cli('shout', 'all', 'warm up')).code, 0);
  await publisherDone(box, warm, 1);
  const asked = join(dirname(box.linkFile), 'relay-checkpoint.asked');
  /** The ask the publisher last received, or null before any. */
  const lastAsk = () => existsSync(asked) ? readFileSync(asked, 'utf8') : null;

  // The first idle command may ask once, since the warm-up move changed the board after the last ask.
  assert.equal((await box.cli('status')).code, 0);
  const settled = lastAsk();
  for (let index = 1; index <= 3; index += 1) {
    assert.equal((await box.cli('status')).code, 0);
    assert.equal(lastAsk(), settled, `idle command ${index} asked the publisher for no new check`);
  }

  writeFileSync(join(box.root, 'SPEC.md'), '# Checkpoint fixture spec\n\n## G · Goals\n\n- G1 [draft, must] SPEC_ONLY_IDLE_CHECK_C7 | gate: review\n');
  const edited = box.calls.length;
  assert.equal((await box.cli('status')).code, 0);
  assert.notEqual(lastAsk(), settled, 'a spec edit with no move asks the publisher again');
  await publisherDone(box, edited, 1);
});

test('a move returns while the publisher asks whether an upload pause is over [H5,H17]', async (t) => {
  const inline = process.env[CHECKPOINT_BACKGROUND_ENV];
  delete process.env[CHECKPOINT_BACKGROUND_ENV];
  t.after(() => { if (inline === undefined) delete process.env[CHECKPOINT_BACKGROUND_ENV]; else process.env[CHECKPOINT_BACKGROUND_ENV] = inline; });
  const box = await relayClientFixture(t);
  await box.link();
  const warm = box.calls.length;
  assert.equal((await box.cli('shout', 'all', 'warm up')).code, 0);
  await publisherDone(box, warm, 1);

  // A size pause from an earlier refused upload; the publisher's next pass first asks the relay if it is over.
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  link.checkpointRefusal = { code: 'BAD_REQUEST', message: 'the snapshot exceeds the size limit', status: 413, size: true };
  writeFileSync(box.linkFile, JSON.stringify(link));
  box.holdProbes(true);
  const release = setTimeout(() => box.holdProbes(false), 10_000); // budget: ceiling: a held probe ends well after the move's limit.
  t.after(() => { clearTimeout(release); box.holdProbes(false); });
  const from = box.calls.length;
  assert.equal((await box.cli('status')).code, 0);
  const deadline = Date.now() + 15_000;
  while (box.heldProbes() === 0 && Date.now() < deadline) await new Promise(next => setTimeout(next, 50));
  assert.equal(box.heldProbes(), 1, 'the publisher\'s pause probe is in flight and held');
  const started = performance.now();
  const moved = await box.cli('shout', 'all', 'moves during the held probe');
  const elapsed = performance.now() - started;
  assert.equal(moved.code, 0, JSON.stringify(moved.document));
  assert.equal(box.heldProbes(), 1, 'the move returned while the probe was still held');
  assert.ok(elapsed < 2000, `the move took ${Math.round(elapsed)} ms; it must not wait for the probe`); // budget: ceiling for one CLI move with headroom, far under the held probe.
  box.holdProbes(false);
  await publisherDone(box, from, 1);
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).checkpointRefusal, undefined, 'the ended pause is cleared');
});

/** A one-commit repository with a relay folder, outside any command's Git-fact scope, as the machine's sender sees it. */
function senderRepo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-checkpoint-inputs-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), '{}\n');
  git('add', 'pullboard.json');
  git('commit', '-q', '-m', 'fixture');
  const file = join(root, '.git', 'pullboard', 'relay.json');
  mkdirSync(dirname(file), { recursive: true });
  return { root, file, git };
}

/** Put a `git` first on PATH that records each call and fails; returns how many calls it saw. */
function gitTrap(t) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-git-trap-')));
  const calls = join(folder, 'calls');
  writeFileSync(join(folder, 'git'), `#!/bin/sh\necho "$*" >> '${calls}'\nexit 1\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${folder}:${path}`;
  const restore = () => { process.env.PATH = path; };
  t.after(() => { restore(); rmSync(folder, { recursive: true, force: true }); });
  return { calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [], restore };
}

test('the sender\'s idle fingerprint runs no Git process once warm, on a branch or a detached primary [C7]', (t) => {
  const { root, file, git } = senderRepo(t);
  const warm = presentationInputs(root, file);
  assert.notEqual(warm, null, 'the fingerprint reads a plain repository');
  let trap = gitTrap(t);
  assert.equal(presentationInputs(root, file), warm, 'an unchanged board keeps its fingerprint');
  assert.deepEqual(trap.calls(), [], 'a warm fingerprint on a branch starts no Git process');
  trap.restore();

  // A primary checkout detached for review keeps its trunk in local config; the fingerprint must still follow it.
  git('config', 'pullboard.trunk', 'refs/heads/main');
  git('checkout', '-q', '--detach');
  const detached = presentationInputs(root, file);
  assert.notEqual(detached, null);
  trap = gitTrap(t);
  assert.equal(presentationInputs(root, file), detached, 'an unchanged detached board keeps its fingerprint');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'1'.repeat(40)}\n`);
  assert.notEqual(presentationInputs(root, file), detached, 'a trunk move changes a detached board\'s fingerprint');
  assert.deepEqual(trap.calls(), [], 'a detached primary reads its retained trunk without Git');
});

test('an ask that fails before reaching the publisher is not recorded, so the next sync asks again [C7]', (t) => {
  const { root, file } = senderRepo(t);
  const directory = dirname(file);
  // A live holder keeps this case from starting a real publisher; the asked marker as a folder makes noting fail.
  writeFileSync(join(directory, 'relay-checkpoint.pid'), `${process.pid}\n`);
  mkdirSync(join(directory, 'relay-checkpoint.asked'));
  assert.throws(() => requestCheckpointCheck(root, file, { now: 1_000 }));
  rmSync(join(directory, 'relay-checkpoint.asked'), { recursive: true });
  assert.equal(requestCheckpointCheck(root, file, { now: 2_000 }), true, 'the failed ask is retried on the next sync');
  assert.equal(requestCheckpointCheck(root, file, { now: 3_000 }), false, 'a delivered ask still holds back an unchanged board');
});
