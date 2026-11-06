/** Touch ID stands in for the person's own terminal only on a board that turns it on, and only on success [B26,R1]. */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import * as store from '../src/board.js';
import { registerPreGrant } from './pre-grant-seats.js';
import * as policy from '../src/policy-settings.js';
import { lineSettings } from '../src/line-settings.js';
import { personChannelFor, requirePersonChannelOrTouchId, TOUCH_ID_CHANNEL, touchIdReason } from '../src/touch-id.js';

const AGENT = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-fixture' };
const PERSON = {};
const APPROVE = { command: 'spec approve', ids: ['RG1', 'RG2'] };
let board;

beforeEach(() => {
  let at = Date.parse('2026-11-06T12:00:00Z');
  board = store.openBoard(':memory:', { now: () => new Date(at++) });
  registerPreGrant(board, [['coordinator', '/repo']]);
});

/** Turn policy.personTouchId on or off as the coordinator records it. */
const setTouchId = (value) => store.setLineSetting(board, { agentId: 'coordinator', key: 'policy.personTouchId', value, reason: 'the person asked for it' });

/** A stub sensor that records each prompt it was shown and answers with one outcome; never the real helper. */
function sensor(outcome, detail) {
  const prompts = [];
  return { prompts, confirm: (reason) => { prompts.push(reason); return { outcome, detail }; } };
}

/** Ask for the channel of a spec approve in the given shell, on the given platform, with a stub sensor, on an unlinked board unless told otherwise. */
const ask = (environment, stub, platform = 'darwin', { relayed = false } = {}) => personChannelFor(board, undefined, { action: APPROVE, environment, platform, confirm: stub.confirm, root: '/repo', relayed: async () => relayed });

test('policy.personTouchId starts off and is a recorded board policy [R1,B26]', () => {
  assert.equal(policy.policyOn(board, 'personTouchId'), false);
  assert.equal(lineSettings(board)['policy.personTouchId'], false);
  setTouchId(true);
  assert.equal(policy.policyOn(board, 'personTouchId'), true);
});

test('with policy.personTouchId off an agent terminal is refused as before and no prompt shows [B26]', async () => {
  const stub = sensor('confirmed');
  await assert.rejects(() => ask(AGENT, stub), { code: 'B26_PERSON_CHANNEL', message: /this terminal belongs to an agent/u });
  assert.deepEqual(stub.prompts, []);
  assert.equal(requirePersonChannelOrTouchId(undefined, () => false, { environment: PERSON }), false);
  assert.throws(() => requirePersonChannelOrTouchId(undefined, () => false, { environment: AGENT }), { code: 'B26_PERSON_CHANNEL' });
  assert.throws(() => requirePersonChannelOrTouchId(undefined, () => { throw new Error('no board'); }, { environment: AGENT }), { code: 'B26_PERSON_CHANNEL' });
  assert.equal(policy.personChannelAccepted(board, TOUCH_ID_CHANNEL), false, 'the board itself refuses a touchid move while the policy is off');
  assert.equal(policy.personOwnChannel(board, TOUCH_ID_CHANNEL), false);
});

test('with it on, a confirmed fingerprint lets the move proceed on the touchid channel, prompting with the exact ids [B26]', async () => {
  setTouchId(true);
  assert.equal(requirePersonChannelOrTouchId(undefined, () => true, { environment: AGENT }), true, 'the early check defers to the board');
  const stub = sensor('confirmed');
  assert.equal(await ask(AGENT, stub), TOUCH_ID_CHANNEL);
  assert.deepEqual(stub.prompts, ['Pullboard: approve spec rows RG1, RG2 (pullboard spec approve)']);
  assert.equal(policy.personChannelAccepted(board, TOUCH_ID_CHANNEL), true);
  assert.equal(policy.personOwnChannel(board, TOUCH_ID_CHANNEL), true);
});

test('with it on, a cancelled, failed, timed-out or unavailable prompt refuses and records nothing [B26]', async () => {
  setTouchId(true);
  for (const [outcome, said] of [['cancelled', /cancelled/u], ['unavailable', /not available/u], ['timeout', /within 60 seconds/u], ['failed', /did not confirm/u]]) {
    const stub = sensor(outcome);
    await assert.rejects(() => ask(AGENT, stub), { code: 'B26_PERSON_CHANNEL', message: said }, outcome);
    assert.equal(stub.prompts.length, 1, `${outcome}: one prompt was shown`);
  }
});

test('with it on, a non-macOS agent terminal or a remote SSH shell is refused without a prompt [B26]', async () => {
  setTouchId(true);
  const linux = sensor('confirmed');
  await assert.rejects(() => ask(AGENT, linux, 'linux'), { code: 'B26_PERSON_CHANNEL', message: /only on macOS/u });
  assert.deepEqual(linux.prompts, []);
  const ssh = sensor('confirmed');
  await assert.rejects(() => ask({ ...AGENT, SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' }, ssh), { code: 'B26_PERSON_CHANNEL' });
  assert.deepEqual(ssh.prompts, []);
  assert.throws(() => requirePersonChannelOrTouchId(undefined, () => true, { environment: { ...AGENT, SSH_CONNECTION: 'x' } }), { code: 'B26_PERSON_CHANNEL' });
});

test('the person\'s own terminal and the view never prompt, whatever the policy [B26]', async () => {
  setTouchId(true);
  const stub = sensor('confirmed');
  assert.equal(await ask(PERSON, stub), 'terminal');
  assert.equal(await personChannelFor(board, 'view', { action: APPROVE, environment: AGENT, platform: 'darwin', confirm: stub.confirm, relayed: async () => false }), 'view');
  assert.deepEqual(stub.prompts, []);
});

test('the prompt is Pullboard\'s own words: unsafe ids are refused and quoted text is stripped of control characters [B26]', () => {
  assert.throws(() => touchIdReason({ command: 'spec approve', ids: ['RG1 and also everything'] }), { code: 'B26_PERSON_CHANNEL' });
  assert.throws(() => touchIdReason({ command: 'spec approve', ids: [] }), { code: 'B26_PERSON_CHANNEL' });
  assert.throws(() => touchIdReason({ command: 'merge everything', ids: ['RG1'] }), { code: 'B26_PERSON_CHANNEL' });
  assert.throws(() => touchIdReason({ command: 'spec answer', ids: ['RG3'], text: 'x'.repeat(200) }), { code: 'B26_PERSON_CHANNEL' });
  assert.equal(touchIdReason({ command: 'spec answer', ids: ['RG3'], text: 'Next.js‮"\n' }), 'Pullboard: answer spec question RG3 with "Next.js \\"" (pullboard spec answer)');
  assert.equal(touchIdReason({ command: 'check accept', ids: ['#12'] }), 'Pullboard: accept the check of item #12 (pullboard check accept)');
});

test('with it on, a relay-linked board refuses before any prompt, as it refuses the person\'s own terminal [B26,H2]', async () => {
  setTouchId(true);
  const stub = sensor('confirmed');
  await assert.rejects(() => ask(AGENT, stub, 'darwin', { relayed: true }), { code: 'B26_PERSON_CHANNEL', message: /linked to the relay.*no prompt was shown/u });
  assert.deepEqual(stub.prompts, []);
});
