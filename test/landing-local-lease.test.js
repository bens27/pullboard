/** Local heartbeat and foreign shared fencing use independent physical SQLite replicas [Q1,Q3,H16,E19]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { exportBoard, importBoard, restoreRelaySnapshot, semanticBoardDigest } from '../src/exchange.js';
import { assertLandingLease } from '../src/landing-lease.js';
import { spawnSync } from 'node:child_process';
import { LANDING_LOCAL_PREFIX, forgetLocalLanding, localLandingEntry, rememberLocalLanding } from '../src/landing-local-lease.js';
import { takeLandingResource } from '../src/landing-resource.js';
import { LANDING_LEASE_ENGINE } from '../src/landing-lease-engine.js';

/** Give each test two physical boards and a private receipt clock, never a live coordinator credential. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-local-heartbeat-'));
  let at = Date.parse('2026-01-01T00:00:00Z');
  const boards = [0, 1].map(index => store.openBoard(join(dir, `${index}.sqlite`), { now: () => new Date(at) }));
  store.register(boards[0], { lane: 'coordinator', path: dir });
  let sequence = 0;
  /** Apply a real ordered private engine receipt with the declared coordinator machine. */
  const move = (board, operation, args, lineage = 'private-lineage-a', machine = 'private-machine-a') => {
    const prepared = { ...prepareEngineMove(board, operation, args), holder: machine };
    const result = applyEngineMove(board, prepared, { sequence: ++sequence, at: new Date(at).toISOString(), standing: { root: true, lineage } });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    return result.result;
  };
  t.after(() => { for (const board of boards) store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  return { boards, move, advance(ms) { at += ms; } };
}

/** Drain promise continuations after advancing only this test's heartbeat intervals. */
async function settle() { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); }

test('a relay stalled for 120 seconds cannot block the holder local landing heartbeat [Q1,Q3,H16]', async t => {
  const box = fixture(t); const [board, replica] = box.boards;
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const actions = [];
  const lease = await takeLandingResource({ board, branch: 'refs/heads/main',
    write: async (operation, args) => {
      actions.push(args[0].action);
      if (args[0].action === 'renew') return new Promise(() => {}); // stand-in relay never acknowledges renewal.
      return box.move(board, operation, args);
    } });
  try {
    const shared = exportBoard(board);
    const digest = semanticBoardDigest(shared);
    for (let step = 0; step < 24; step += 1) {
      box.advance(5000); t.mock.timers.tick(5000); await settle();
    }
    await lease.assertHeld();
    assert.deepEqual(actions, ['request'], '120 seconds of heartbeats never invoked the stalled relay writer');
    assert.equal(semanticBoardDigest(exportBoard(board)), digest, 'local deadlines do not change shared semantic state');
    assert.ok(Date.parse(lease.assertCurrent().until) > board.clock.now().getTime());
    assert.equal(shared.tables.board_meta.some(row => row.meta_key.startsWith(LANDING_LOCAL_PREFIX)), false);
    importBoard(replica, shared);
    assert.equal(replica.db.prepare('SELECT count(*) AS n FROM board_meta WHERE meta_key GLOB ?').get(LANDING_LOCAL_PREFIX + '*').n, 0);
    restoreRelaySnapshot(board, shared, 1, digest);
    assertLandingLease(board, lease.fence); // checkpoint replacement retains only this physical board's local heartbeat.
    const foreign = { agentId: 'coordinator', action: 'request', token: randomUUID(), branch: 'refs/heads/main', pid: process.pid };
    assert.equal(store.landingLeaseMove(replica, foreign).acquired, false, 'a replica cannot grant past unseen local renewals using its expired shared clock');
    store.landingLeaseMove(replica, { agentId: 'coordinator', action: 'release', ...lease.fence });
    assert.equal(store.landingLeaseMove(replica, foreign).acquired, true, 'explicit release admits the foreign waiter');
  } finally { await lease.release(); }
});

test('coordinator takeover fences an unreleased foreign landing without inventing a new expiry [Q1,Q3,E19]', t => {
  const box = fixture(t); const [board, replica] = box.boards;
  const first = { agentId: 'coordinator', action: 'request', token: randomUUID(), branch: 'refs/heads/main', pid: process.pid };
  const grant = box.move(board, 'landingLeaseMove', [first]);
  importBoard(replica, exportBoard(board));
  box.advance(120_000);
  const second = { ...first, token: randomUUID() };
  assert.equal(store.landingLeaseMove(replica, second).acquired, false);
  box.move(replica, 'takeCoordinator', [{ agentId: 'coordinator', machine: 'private-machine-b' }], 'private-lineage-b', 'private-machine-b');
  assert.throws(() => assertLandingLease(replica, { ...first, generation: grant.generation }), error => error.code === 'LAND_LEASE_LOST');
  const successor = box.move(replica, 'landingLeaseMove', [second], 'private-lineage-b', 'private-machine-b');
  assert.equal(successor.acquired, true);
  assert.ok(successor.generation > grant.generation);
});


test('physical heartbeat identity cannot attach to another board or arrive in an import [Q1,Q3,H16]', async t => {
  const box = fixture(t); const [board, replica] = box.boards;
  const lease = await takeLandingResource({ board, branch: 'refs/heads/main', write: async (operation, args) => box.move(board, operation, args) });
  try {
    const holder = store.landingLeaseState(board).holder;
    const row = board.db.prepare('SELECT * FROM board_meta WHERE meta_key=?').get(LANDING_LOCAL_PREFIX + holder.token);
    const document = exportBoard(board);
    document.tables.board_meta.push(row); // imported local metadata is deliberately untrusted, even with an exact token.
    importBoard(replica, document);
    assert.equal(localLandingEntry(replica, holder), null);
    const old = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
    board.db.prepare("UPDATE board_meta SET meta_value=? WHERE meta_key='board_id'").run('different-private-board');
    assert.equal(localLandingEntry(board, holder), null, 'board identity participates in the local token/generation binding');
    board.db.prepare("UPDATE board_meta SET meta_value=? WHERE meta_key='board_id'").run(old);
  } finally { await lease.release(); }
});


/** A real process ID that has already exited and been reaped on this computer. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

/** Queue one invocation through a real receipt and record it locally exactly as takeLandingResource does. */
function queueLocal(box, board, pid) {
  const request = { agentId: 'coordinator', action: 'request', token: randomUUID(), branch: 'refs/heads/main', pid, localHeartbeat: true };
  const result = box.move(board, 'landingLeaseMove', [request]);
  const acknowledged = result.acquired ? result.holder : store.landingLeaseState(board).line.find(entry => entry.token === request.token);
  rememberLocalLanding(board, acknowledged);
  return request;
}

/** Fail on the first wait, so a lease that would wait without end fails the test instead of hanging it. */
function refuseWait(waits) {
  return async wait => { waits.push(wait); throw new Error(`landing waited at place ${wait.position} behind ${wait.holders[0]?.label}`); };
}

test('a killed landing promoted from the line on a linked board, and killed waiters, never block the next land on this computer [Q1,Q3,H16]', async t => {
  const box = fixture(t); const [board] = box.boards;
  const first = queueLocal(box, board, deadPid());
  const killedWaiter = queueLocal(box, board, deadPid()); // killed while it waited behind the first landing.
  box.move(board, 'landingLeaseMove', [{ ...first, action: 'release', generation: 1 }]);
  forgetLocalLanding(board, first.token);
  const later = [queueLocal(box, board, deadPid()), queueLocal(box, board, deadPid())]; // each request promotes or queues, then is killed.
  const stuck = store.landingLeaseState(board);
  assert.equal(stuck.holder.token, killedWaiter.token, 'a later request promoted the killed waiter to holder');
  assert.notEqual(stuck.holder.lineage, null, 'the board is relay-linked');
  assert.equal(stuck.line.length, 2, 'killed waiters held places in the line');
  const waits = [];
  const lease = await takeLandingResource({ board, branch: 'refs/heads/main', onWait: refuseWait(waits),
    write: async (operation, args) => box.move(board, operation, args) });
  try {
    assert.deepEqual(waits, [], 'the next land on this computer took the lease without waiting');
    const state = store.landingLeaseState(board);
    assert.equal(state.holder.token, lease.fence.token);
    assert.deepEqual(state.line, [], 'dead waiters hold no place');
    for (const request of [killedWaiter, ...later]) {
      assert.equal(board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(LANDING_LOCAL_PREFIX + request.token), undefined);
    }
  } finally { await lease.release(); }
});

test('a live landing on this computer and a holder from another computer still keep the trunk [Q1,Q3,H16]', async t => {
  const box = fixture(t); const [board, replica] = box.boards;
  const live = queueLocal(box, board, process.pid);
  const waits = [];
  await assert.rejects(takeLandingResource({ board, branch: 'refs/heads/main', onWait: refuseWait(waits),
    write: async (operation, args) => box.move(board, operation, args) }), /landing waited at place 1/u);
  assert.equal(store.landingLeaseState(board).holder.token, live.token, 'a live local holder is respected');
  importBoard(replica, exportBoard(board));
  box.move(replica, 'landingLeaseMove', [{ ...live, action: 'release', generation: 1 }]);
  const foreign = { agentId: 'coordinator', action: 'request', token: randomUUID(), branch: 'refs/heads/main', pid: deadPid(), localHeartbeat: true };
  box.move(replica, 'landingLeaseMove', [foreign]); // another computer records no local entry on this board, so its PID means nothing here.
  const foreignWaiter = { ...foreign, token: randomUUID(), pid: deadPid() };
  box.move(replica, 'landingLeaseMove', [foreignWaiter]);
  await assert.rejects(takeLandingResource({ board: replica, branch: 'refs/heads/main', onWait: refuseWait(waits),
    write: async (operation, args) => box.move(replica, operation, args) }), /landing waited at place 2/u);
  const state = store.landingLeaseState(replica);
  assert.equal(state.holder.token, foreign.token, 'a holder on another computer is never released by PID');
  assert.deepEqual(state.line.map(entry => entry.token), [foreignWaiter.token], 'a foreign waiter keeps its place');
});

test('historical landing lease receipts retain their original renewal events [Q1,H16]', t => {
  const box = fixture(t); const [board] = box.boards;
  const request = { agentId: 'coordinator', action: 'request', token: randomUUID(), branch: 'refs/heads/main', pid: process.pid };
  let sequence = 0;
  /** Replay the old sealed protocol rather than silently rewriting historical event meaning. */
  const oldMove = args => {
    const move = { ...prepareEngineMove(board, 'landingLeaseMove', [args]), engine: LANDING_LEASE_ENGINE };
    const outcome = applyEngineMove(board, move, { sequence: ++sequence, at: board.clock.now().toISOString() });
    assert.equal(outcome.error, undefined, JSON.stringify(outcome.error));
    return outcome.result;
  };
  const grant = oldMove(request);
  box.advance(1000);
  oldMove({ ...request, action: 'renew', generation: grant.generation });
  assert.equal(board.db.prepare("SELECT count(*) AS n FROM event WHERE event_kind='landing_lease'").get().n, 2);
});
