/** A board move too large for the relay body limit must never wedge the ordered outbox [A6,B26,H16]. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as store from '../src/board.js';
import { loadConfig } from '../src/config.js';
import { loadDoctrine } from '../src/doctrine.js';
import { appliedSequence, prepareEngineMove } from '../src/engine.js';
import { healthReport } from '../src/health.js';
import { stampCoordinatorHolder } from '../src/coordinator-hold.js';
import { outboxEntrySummary, outboxFile, outboxSummaryFile, writeOutbox } from '../src/relay-outbox.js';
import { credentialActor, operationIntent, relayMoveActor } from '../src/relay-sender.js';
import { decodeBoardKey } from '../src/seal.js';
import { frozenCriterion, loadSpec } from '../src/spec.js';
import { runFixtureGit } from './fixture-child.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { mirrorPending } from '../src/relay-move-size.js';

const HOUR = 3_600_000;
const RELAY_BODY_BYTES = 100_000;
const STUCK_SEATS = 400;

/** Turn the board's committed relay.outbox setting on, as its coordinator would. */
function enableOutbox(box) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { outbox: true } }, null, 2) + '\n');
  const cliPath = fileURLToPath(new URL('../bin/pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore(config): queue relay moves while the relay is down'], { cwd: box.root, env: box.env });
}

/** Give the board enough lapsed claims that one raw health scan exceeds the relay body limit. */
function lapseManyClaims(box) {
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const board = store.openBoard(file, { now: () => new Date(Date.now() - 2 * HOUR) });
  try {
    const config = loadConfig(box.root);
    const freeze = item => frozenCriterion(loadSpec(box.root, config), item, loadDoctrine(box.root, config));
    for (let index = 0; index < STUCK_SEATS; index += 1) {
      const agentId = store.register(board, { lane: box.lane, path: join(box.root, '..', `stuck-seat-${index + 1}`) });
      const id = store.addItem(board, { by: 'coordinator', lane: box.lane, title: `Stuck relay fixture ${index + 1}` });
      store.claim(board, id, { agentId, lane: box.lane, leaseMs: HOUR, freeze });
    }
  } finally { board.db.close(); }
}

/** Every move POST stayed under the relay's body limit and was taken. */
function assertMovesFit(box) {
  const posts = box.calls.filter(call => call.method === 'POST' && /\/moves$/u.test(call.path ?? ''));
  assert.ok(posts.length > 0, 'the client sent moves to the relay');
  for (const call of posts) {
    assert.ok(call.requestBytes < RELAY_BODY_BYTES, `a move body of ${call.requestBytes} bytes stays under the relay limit`);
    assert.equal(call.status, 200, `the relay took the move (${call.requestBytes} bytes)`);
  }
}

/** The outbox drained and later moves still reach the board. */
async function assertOutboxFlows(box) {
  const after = await box.cli('shout', 'all', 'after the health scan');
  assert.equal(after.code, 0, after.failure);
  const status = await box.cli('status');
  assert.equal(status.code, 0, status.failure);
  assert.equal(status.document.relay.outbox, undefined, 'the outbox is empty once it replays');
  const exported = await box.cli('export');
  assert.ok(exported.document.tables.shout.some(row => row.shout_text === 'after the health scan'), 'a move after the health scan reaches the board');
  assertMovesFit(box);
  return exported.document;
}

test('a health scan on a board with many stuck items stays under the relay body limit [A6,B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  enableOutbox(box);
  lapseManyClaims(box);
  await box.link();

  const scanned = await box.cli('sentinel', 'run', '--health-only');
  assert.equal(scanned.code, 0, scanned.failure);
  const exported = await assertOutboxFlows(box);
  const scans = exported.tables.event.filter(row => row.event_kind === 'health-scan');
  assert.ok(scans.length > 0, 'the relay ordered the health scan');
  const active = JSON.parse(scans.at(-1).event_detail).active;
  const omitted = active.find(finding => finding.cause === 'HEALTH_FINDINGS_OMITTED');
  assert.ok(omitted, 'the recorded scan says some findings were left out');
  assert.match(omitted.title, /health findings, \d+ not recorded/u);
});

test('an oversized health move already queued is compacted and sent, never left blocking the outbox [A6,B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  enableOutbox(box);
  lapseManyClaims(box);
  await box.link();

  // Seed the outbox as an older client left it: one raw health move bigger than the relay accepts.
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const board = store.openBoard(file);
  let entry;
  let baseSequence;
  try {
    const findings = healthReport({ db: board.db, root: box.root, config: loadConfig(box.root), now: new Date() }).stuck;
    assert.ok(Buffer.byteLength(JSON.stringify(findings)) > RELAY_BODY_BYTES, 'the raw findings exceed the relay body limit');
    const observedRevision = board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS revision FROM event').get().revision;
    const args = [{ agentId: 'coordinator', observedRevision, findings }];
    const move = stampCoordinatorHolder(prepareEngineMove(board, 'recordHealthFindings', args), state.machine, state.computerName);
    move.actor = relayMoveActor(move) ?? credentialActor(move);
    baseSequence = appliedSequence(board);
    const sequences = board.db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all().map(row => ({ name: row.name, seq: row.seq }));
    entry = { move, refs: [], intent: operationIntent('recordHealthFindings', args), queuedAt: new Date().toISOString(),
      after: Math.max(state.sequence, baseSequence), sequences, changes: [] };
  } finally { board.db.close(); }
  await writeOutbox(outboxFile(box.linkFile), key, state.board, { version: 3, baseSequence, restored: false, moves: [entry] });
  writeFileSync(outboxSummaryFile(box.linkFile), JSON.stringify({ restored: false, moves: [outboxEntrySummary(entry)] }) + '\n', { mode: 0o600 });

  await assertOutboxFlows(box);
});

const LONG_TITLES = 30;

/** Turn the ordered link back into an older client's mirror link, so the next command migrates it. */
function legacyMirrorLink(box) {
  const board = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let cursor;
  try { cursor = board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id; } finally { board.db.close(); }
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  link.cursor = cursor;
  delete link.mode;
  delete link.presentationDigest;
  writeFileSync(box.linkFile, JSON.stringify(link) + '\n', { mode: 0o600 });
  return link;
}

/** Add local items the mirror has not sent yet; long titles make the board's presentation exceed the body limit. */
function addUnmirroredItems(box, count, title) {
  const board = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    for (let index = 0; index < count; index += 1) store.addItem(board, { by: 'coordinator', lane: box.lane, title: `${title} ${index + 1}` });
  } finally { board.db.close(); }
}

/** Migration finished in relay order, with every mirrored record under the limit and the items still on the board. */
async function assertMirrorMigrates(box, title) {
  const status = await box.cli('status');
  assert.equal(status.code, 0, status.failure);
  assertMovesFit(box);
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(link.mode, 'ordered', 'the mirror migrated to relay order');
  assert.equal(link.pending, undefined, 'no mirrored record is left pending');
  const exported = await box.cli('export');
  assert.ok(exported.document.tables.item.some(row => row.item_title.startsWith(title)), 'the mirrored items stay on the board');
}

test('a mirror record whose presentation is over the relay body limit is sent without it, never posted to a sure refusal [B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  legacyMirrorLink(box);
  const title = 'Mirrored long title ' + 'x'.repeat(4_000);
  addUnmirroredItems(box, LONG_TITLES, title);
  await assertMirrorMigrates(box, title);
});

test('an older mirror link with several unsent records migrates on a paged relay, its presentation left to the checkpoint [B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  legacyMirrorLink(box);
  addUnmirroredItems(box, 3, 'Mirrored short title');
  await assertMirrorMigrates(box, 'Mirrored short title');
});

test('a mirror linked before its relay served pages migrates after the upgrade, even with a snapshot saved from a failed try [B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = legacyMirrorLink(box);
  assert.equal(link.snapshotApiVersion, 2, 'the fixture link starts on the paged API');
  // Recreate an API1-era link and the presentation snapshot an earlier try saved at the mirror sequence.
  delete link.snapshotApiVersion;
  link.snapshot = { sequence: link.sequence, sealed: 'A'.repeat(64) };
  link.needsPresentation = true;
  writeFileSync(box.linkFile, JSON.stringify(link) + '\n', { mode: 0o600 });
  addUnmirroredItems(box, 2, 'Mirrored before the page upgrade');
  await assertMirrorMigrates(box, 'Mirrored before the page upgrade');
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).snapshot, undefined, 'the saved mirror snapshot is not retried');
});

test('an oversized mirror record an older client left pending is resealed under the limit, never retried forever [B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = legacyMirrorLink(box);
  addUnmirroredItems(box, 1, 'Mirrored after an oversized record');
  link.pending = { localEvent: link.cursor + 1, sequence: link.sequence + 1, needsPresentation: false, sealed: 'A'.repeat(RELAY_BODY_BYTES + 10_000) };
  writeFileSync(box.linkFile, JSON.stringify(link) + '\n', { mode: 0o600 });
  await assertMirrorMigrates(box, 'Mirrored after an oversized record');
});

test('a mirror record too large even without its presentation is refused with the re-link step, never posted [B26,H16]', async () => {
  const event = { event_id: 7 };
  const presentation = { state: { events: [{ event_id: 7 }] } };
  const sealedSizes = [];
  const seal = async (record) => {
    const sealed = 'A'.repeat(RELAY_BODY_BYTES + 1);
    sealedSizes.push(record.presentation ? 'with presentation' : 'event alone');
    return sealed;
  };
  await assert.rejects(mirrorPending({ sequence: 3, needsPresentation: false }, event, () => presentation, seal), (error) => {
    assert.equal(error.code, 'RELAY_MOVE_TOO_LARGE');
    assert.match(error.message, /local event 7 would send \d+ bytes/u);
    assert.match(error.next, /relay off.*relay on/u);
    return true;
  });
  assert.deepEqual(sealedSizes, ['with presentation', 'event alone'], 'it tries the record without its presentation before refusing');
});
