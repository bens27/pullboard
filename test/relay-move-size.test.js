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
