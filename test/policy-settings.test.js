/** Workflow policies are board settings, off until the board turns them on [V1,B3,B26,R1]. */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import * as store from '../src/board.js';
import { applyRelayMove, appliedSequence } from '../src/engine.js';
import { relaySenderProblem, credentialActor } from '../src/relay-sender.js';
import { ENGINE_VERSION, VERIFIER_STANDING_ENGINE } from '../src/machine.js';
import { registerPreGrant } from './pre-grant-seats.js';
import { submitFixture } from './board-submit-fixture.js';
import { FOR_PERSON_CHANNEL, POLICY_SETTINGS, policyOn } from '../src/policy-settings.js';
import { lineSettings } from '../src/line-settings.js';
import { checkDigest } from '../src/check-accept.js';

const HOUR = 3_600_000;
const SHA_A = 'a'.repeat(40);
let board;

beforeEach(() => {
  let at = Date.parse('2026-11-05T12:00:00Z');
  board = store.openBoard(':memory:', { now: () => new Date(at++) });
  registerPreGrant(board, [['coordinator', '/repo'], ['web', '/repo-web-1'], ['web', '/repo-web-2']]);
});

/** Turn one policy on or off as the coordinator records it. */
const setPolicy = (name, value) => store.setLineSetting(board, { agentId: 'coordinator', key: `policy.${name}`, value, reason: 'the person asked for it' });

/** The frozen bar a relay verdict replays against: it carries the verify policy captured at claim. */
const frozenWithPolicy = () => ({ text: JSON.stringify({ policy: { version: 1, commit: SHA_A, verify: { policy: 'any', family: 'off' } } }), digest: 'digest:Page' });

/** Add, claim and submit one item built by web-1. */
function submitted() {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze: frozenWithPolicy });
  submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 'tree-a' });
  return id;
}

/** The verify arguments a seat sends for this item. */
const verdict = (agentId) => ({ agentId, decision: 'ACCEPT', reason: 'CRITERION_MET', head: SHA_A, digest: 'digest:Page', policy: 'any', note: 'ran the check' });

test('a new board starts with selfVerify on and every other policy off, and needs no window to change [R1,V1]', () => {
  const defaults = { verifierStanding: false, selfVerify: true, mainVerifier: false, personChannel: false, personTouchId: false, personPhoneOnly: false };
  for (const name of Object.keys(POLICY_SETTINGS)) {
    assert.equal(policyOn(board, name), defaults[name], `${name} starts at the person's default`);
    assert.equal(lineSettings(board)[`policy.${name}`], defaults[name]);
  }
  const change = setPolicy('selfVerify', false);
  assert.equal(change.window, undefined, 'a policy carries no measured window');
  assert.equal(policyOn(board, 'selfVerify'), false);
  assert.equal(store.events(board).filter(event => event.event_kind === 'line_setting').length, 1, 'the change is an ordered, recorded event');
  setPolicy('selfVerify', true);
  assert.equal(policyOn(board, 'selfVerify'), true);
  assert.throws(() => store.setLineSetting(board, { agentId: 'web-1', key: 'policy.selfVerify', value: true, reason: 'x' }), /COORDINATOR_ONLY/u);
});

test('with policy.selfVerify off an earlier claimer verifies; the building seat never does [V1]', () => {
  /** web-2 claims and releases, then web-1 builds and submits, so web-2 is an earlier author. */
  const handedOver = () => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const freeze = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });
    store.claim(board, id, { agentId: 'web-2', lane: 'web', leaseMs: 2 * HOUR, freeze });
    store.release(board, id, 'web-2');
    store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze });
    submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 'tree-a' });
    return id;
  };
  const id = handedOver();
  assert.equal(policyOn(board, 'selfVerify'), true, 'on by default');
  assert.throws(() => store.verify(board, id, verdict('web-2')), /SELF_VERIFY/u, 'on: any earlier author is refused');
  setPolicy('selfVerify', false);
  assert.throws(() => store.verify(board, id, verdict('web-1')), /SELF_VERIFY/u, 'the schema keeps the building seat out');
  assert.equal(store.verify(board, id, verdict('web-2')).decision, 'ACCEPT', 'off: the earlier claimer verifies');
  assert.equal(store.getItem(board, id).item_status, 'verified');
});

test('with policy.verifierStanding off a linked verdict is accepted on relay replay; on, it is refused [B3]', () => {
  /** Replay one verify from web-2 as the relay delivers it on a linked board. */
  const replay = (id, n) => applyRelayMove(board, { version: 1, engine: ENGINE_VERSION, id: `policy-standing-${n}`, operation: 'verify', args: [id, verdict('web-2')] }, {
    sequence: appliedSequence(board) + 1, at: new Date().toISOString(), kind: 'move',
    sender: { kind: 'agent', agent: 'web-2', userId: '1', policy: VERIFIER_STANDING_ENGINE } });
  const first = submitted();
  setPolicy('verifierStanding', true);
  assert.equal(replay(first, 1).error?.code, 'VERIFIER_STANDING', 'the policy on keeps the relay standing rule');
  setPolicy('verifierStanding', false);
  const second = submitted();
  const accepted = replay(second, 2);
  assert.equal(accepted.error, undefined, JSON.stringify(accepted.error));
  assert.equal(store.getItem(board, second).item_status, 'verified');
});

test('a for-person move travels under the coordinator only while policy.personChannel is off [B26]', () => {
  const move = { engine: VERIFIER_STANDING_ENGINE, operation: 'acceptCheck', args: [1, { agentId: 'person', channel: FOR_PERSON_CHANNEL, digest: 'd', note: 'the person said accept it' }] };
  const coordinator = { kind: 'agent', agent: 'coordinator', userId: '1', policy: VERIFIER_STANDING_ENGINE };
  assert.equal(credentialActor(move), 'coordinator');
  assert.equal(relaySenderProblem(move, coordinator, 'move', { board }), null);
  assert.equal(relaySenderProblem(move, { ...coordinator, agent: 'web-1' }, 'move', { board })?.code, 'RELAY_PERSON_ONLY', 'no other seat records for the person');
  assert.equal(relaySenderProblem({ ...move, args: [1, { ...move.args[1], channel: 'terminal' }] }, coordinator, 'move', { board })?.code, 'RELAY_PERSON_ONLY',
    'a plain person move still needs the person');
  setPolicy('personChannel', true);
  assert.equal(relaySenderProblem(move, coordinator, 'move', { board })?.code, 'RELAY_PERSON_ONLY');
});

test('a for-person check acceptance names the coordinator and the person\'s words, and needs the policy off [B26]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Held', check: 'true' });
  const digest = checkDigest(store.getItem(board, id).item_check);
  assert.throws(() => store.acceptCheck(board, id, { agentId: 'person', channel: FOR_PERSON_CHANNEL, digest }), /FOR_PERSON_NOTE/u);
  setPolicy('personChannel', true);
  assert.throws(() => store.acceptCheck(board, id, { agentId: 'person', channel: FOR_PERSON_CHANNEL, digest, note: 'the person: accept it' }), /B26_PERSON_CHANNEL/u);
  setPolicy('personChannel', false);
  store.acceptCheck(board, id, { agentId: 'person', channel: FOR_PERSON_CHANNEL, digest, note: 'the person: accept it' });
  const event = store.events(board).find(entry => entry.event_kind === 'check_accept');
  const detail = typeof event.event_detail === 'string' ? JSON.parse(event.event_detail) : event.event_detail;
  assert.deepEqual({ channel: detail.channel, recordedBy: detail.recordedBy, note: detail.note }, { channel: FOR_PERSON_CHANNEL, recordedBy: 'coordinator', note: 'the person: accept it' });
});
