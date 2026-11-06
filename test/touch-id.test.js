/** Touch ID stands in for the person's own terminal only on a board that turns it on, and only on success [B26,R1]. */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import * as store from '../src/board.js';
import { registerPreGrant } from './pre-grant-seats.js';
import * as policy from '../src/policy-settings.js';
import { lineSettings } from '../src/line-settings.js';
import { readFileSync } from 'node:fs';
import * as touchId from '../src/touch-id.js';

const { personChannelFor, requirePersonChannelOrTouchId, TOUCH_ID_CHANNEL, touchIdReason } = touchId;

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

/** A stub of this Mac's sealed person sign-in: records each unwrap and its prompt, never the real helper. */
function macPerson({ signedIn = true, outcome = 'confirmed' } = {}) {
  const opened = [];
  return { opened, macPersonSignedIn: () => signedIn, openMacPersonSession: ({ origin, reason, io }) => { opened.push({ origin, reason, io }); return { outcome }; } };
}

/**
 * Ask for the channel of a spec approve in the given shell, on the given platform, with a stub sensor, on an
 * unlinked board unless a link is given. `relayed` is the older option name, kept so these tests also run
 * against the previous behaviour.
 */
const ask = (environment, stub, platform = 'darwin', { link = null, mac = macPerson(), io = {} } = {}) => personChannelFor(board, undefined,
  { action: APPROVE, environment, platform, confirm: stub.confirm, root: '/repo', io, relayed: async () => Boolean(link), linked: async () => link, macPerson: mac });

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

const LINK = { url: 'https://relay.example' };
const PROMPT = 'Pullboard: approve spec rows RG1, RG2 (pullboard spec approve)';

test('on a relay-linked board signed in on this Mac, one fingerprint unwraps the sign-in and confirms the move [B26,H16]', async () => {
  setTouchId(true);
  const stub = sensor('confirmed');
  const mac = macPerson();
  const io = {};
  assert.equal(await ask(AGENT, stub, 'darwin', { link: LINK, mac, io }), TOUCH_ID_CHANNEL);
  assert.deepEqual(stub.prompts, [], 'no separate confirm prompt: the unwrap is the one fingerprint');
  assert.deepEqual(mac.opened.map(({ origin, reason }) => [origin, reason]), [[LINK.url, PROMPT]], 'one unwrap, prompting with the move and its ids');
  assert.equal(mac.opened[0].io, io, 'the unwrapped sign-in is held for this command only');
});

test('on a linked board a declined fingerprint refuses and sends nothing [B26,H16]', async () => {
  setTouchId(true);
  for (const outcome of ['cancelled', 'unavailable', 'failed']) {
    const mac = macPerson({ outcome });
    await assert.rejects(() => ask(AGENT, sensor('confirmed'), 'darwin', { link: LINK, mac }), { code: 'B26_PERSON_CHANNEL', message: /nothing was sent/u }, outcome);
    assert.equal(mac.opened.length, 1, `${outcome}: exactly one prompt`);
  }
});

test('on a linked board policy.personPhoneOnly or a missing Mac sign-in refuses HUMAN_REQUIRED before any prompt [B26,R1]', async () => {
  setTouchId(true);
  const unsigned = macPerson({ signedIn: false });
  await assert.rejects(() => ask(AGENT, sensor('confirmed'), 'darwin', { link: LINK, mac: unsigned }), { code: 'HUMAN_REQUIRED', message: /no prompt was shown/u });
  assert.deepEqual(unsigned.opened, []);
  store.setLineSetting(board, { agentId: 'coordinator', key: 'policy.personPhoneOnly', value: true, reason: 'the person wants the phone only' });
  const phoneOnly = macPerson();
  const stub = sensor('confirmed');
  await assert.rejects(() => ask(AGENT, stub, 'darwin', { link: LINK, mac: phoneOnly }), { code: 'HUMAN_REQUIRED', message: /personPhoneOnly/u });
  assert.deepEqual([phoneOnly.opened, stub.prompts], [[], []]);
});

test('an agent terminal with policy.personTouchId off is refused B26 with zero helper calls, linked or not [B26]', async () => {
  const calls = [];
  const restore = touchId.useTouchIdHelper((args) => { calls.push(args); return { status: 0, stdout: 'confirmed' }; });
  try {
    for (const link of [null, LINK]) {
      const mac = macPerson();
      await assert.rejects(() => personChannelFor(board, undefined, { action: APPROVE, environment: AGENT, platform: 'darwin', root: '/repo', io: {}, relayed: async () => Boolean(link), linked: async () => link, macPerson: mac }),
        { code: 'B26_PERSON_CHANNEL' });
      assert.deepEqual(mac.opened, []);
    }
  } finally { restore(); }
  assert.deepEqual(calls, [], 'the helper never ran');
});

test('the helper is asked once per step with the prompt as its own argument, and the session only on stdin [B26]', () => {
  const calls = [];
  const restore = touchId.useTouchIdHelper((args, input) => {
    calls.push({ args, input });
    if (args[0] === 'seal') return { status: 0, stdout: '{"v":1,"key":"k","ephemeral":"e","box":"b"}\n' };
    if (args[0] === 'open') return { status: 0, stdout: 'ps_session' };
    return { status: 2, stderr: 'cancelled' };
  });
  try {
    assert.deepEqual(touchId.sealWithTouchId('ps_secret'), { outcome: 'confirmed', sealed: '{"v":1,"key":"k","ephemeral":"e","box":"b"}' });
    assert.deepEqual(touchId.openWithTouchId(PROMPT, '{"v":1}'), { outcome: 'confirmed', token: 'ps_session' });
    assert.equal(touchId.runTouchIdHelper(PROMPT).outcome, 'cancelled');
  } finally { restore(); }
  assert.deepEqual(calls, [{ args: ['seal'], input: 'ps_secret' }, { args: ['open', PROMPT], input: '{"v":1}' }, { args: ['confirm', PROMPT], input: undefined }]);
});

test('there is no password path: fingerprint-only access, no keychain password read [B26,H16]', () => {
  const swift = touchId.TOUCH_ID_SWIFT;
  assert.match(swift, /\.biometryCurrentSet/u);
  assert.match(swift, /SecureEnclave\.P256\.KeyAgreement\.PrivateKey\(accessControl:/u);
  for (const fallback of [/\.devicePasscode/u, /\.userPresence/u, /deviceOwnerAuthentication[^W]/u, /\.or\b/u]) assert.doesNotMatch(swift, fallback);
  assert.match(swift, /localizedFallbackTitle = ""/u, 'no "Enter password" button');
  const mac = readFileSync(new URL('../src/relay-mac-person.js', import.meta.url), 'utf8');
  assert.doesNotMatch(mac, /child_process|find-generic-password|['"]security['"]/u, 'the kept sign-in is never read through security, whose prompt takes the login password');
});
