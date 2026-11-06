/** On a linked board the person's own Mac counts as the person, while agent terminals stay refused [B26,H16]. */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { relayClientFixture, relayFixtureChild } from './relay-client-fixture.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');
const SPEC = '# Mac person fixture spec\n\n## G · Goals\n\n- G1 [draft, must] A row the person approves from the Mac | gate: review\n';

/**
 * A stand-in for the Touch ID helper, loaded into every CLI child of this fixture by a preload, so no test
 * compiles or runs the real helper or reaches the Secure Enclave. It records every call (mode, prompt and
 * whether stdin carried a session, never the session), seals by base64 so the kept file holds no plain
 * session, and answers an unwrap as the sensor would after a fingerprint, or refuses as a cancelled one.
 */
function fakeTouchId(box) {
  const directory = join(box.env.PATH, '..');
  const log = join(directory, 'fake-touchid-log.jsonl');
  const declined = join(directory, 'fake-touchid.decline');
  const preload = join(directory, 'fake-touchid-preload.mjs');
  writeFileSync(preload, `
import { appendFileSync, existsSync } from 'node:fs';
import { useTouchIdHelper } from ${JSON.stringify(new URL('../src/touch-id.js', import.meta.url).href)};
useTouchIdHelper((args, input) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, session: /ps_[A-Za-z0-9_-]{43}/u.test(input ?? '') }) + '\\n');
  if (args[0] === 'seal') return { status: 0, stdout: JSON.stringify({ v: 1, key: 'enclave-wrapped', ephemeral: 'e', box: Buffer.from(input).toString('base64') }) };
  if (existsSync(${JSON.stringify(declined)})) return { status: 2, stderr: 'Canceled by user.' };
  if (args[0] === 'open') return { status: 0, stdout: Buffer.from(JSON.parse(input).box, 'base64').toString('utf8') };
  return { status: 0, stdout: 'confirmed' };
});
`);
  box.env.NODE_OPTIONS = [box.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ');
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  return {
    calls,
    opens: () => calls().filter((call) => call.args[0] === 'open'),
    sealed: () => readdirSync(join(box.env.PULLBOARD_MACHINE_HOME, 'relay-person')).map((name) => JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'relay-person', name), 'utf8'))),
    decline: (value) => { if (value) writeFileSync(declined, ''); else rmSync(declined, { force: true }); },
  };
}

/** True when any regular file below this folder holds a person session. */
function holdsPersonSession(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory() && holdsPersonSession(path)) return true;
    if (stat.isFile() && /ps_[A-Za-z0-9_-]{43}/u.test(readFileSync(path).toString('latin1'))) return true;
  }
  return false;
}

test('the person\'s own Mac approves a row on a linked board with one fingerprint, and an agent terminal still cannot [B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  const touch = fakeTouchId(box);
  await box.link();
  writeFileSync(join(box.root, 'SPEC.md'), SPEC);

  // Before the person signs this Mac in, a linked board still sends person moves to the phone.
  const unsigned = await box.cli('spec', 'approve', 'G1');
  assert.equal(unsigned.document.error?.code, 'HUMAN_REQUIRED', 'no Mac sign-in: the paired phone is still the way');
  assert.deepEqual(touch.calls(), [], 'no helper call without a kept sign-in');

  const signed = await box.cli('relay', 'person', 'on');
  assert.equal(signed.code, 0, `the person signs this Mac in from their own terminal: ${JSON.stringify(signed.document)}`);
  assert.deepEqual(touch.calls(), [{ args: ['seal'], session: true }], 'sealing takes the session on stdin, never in an argument, and asks for no fingerprint');
  const kept = touch.sealed();
  assert.equal(kept.length, 1, 'one sealed sign-in is kept');
  assert.equal(kept[0].key, 'enclave-wrapped', 'it is sealed to the enclave key');
  for (const directory of [box.env.HOME, box.env.PULLBOARD_MACHINE_HOME, join(box.root, '.git')]) assert.equal(holdsPersonSession(directory), false, `no file under ${directory} holds the session in the clear`);
  assert.equal(/ps_[A-Za-z0-9_-]{43}/u.test(JSON.stringify(signed.document)), false, 'the command never prints the session');

  // An agent's terminal is refused before the helper is asked.
  const agent = await relayFixtureChild(box.root, { ...box.env, CLAUDECODE: '1' }, [CLI, 'spec', 'approve', 'G1', '--json']);
  assert.equal(agent.document.error?.code, 'B26_PERSON_CHANNEL', 'an agent terminal stays refused');
  assert.equal(touch.calls().length, 1, 'an agent terminal never asks the helper');

  // The person declining the fingerprint records nothing.
  touch.decline(true);
  const acks = box.moveAcks.length;
  const declined = await box.cli('spec', 'approve', 'G1');
  assert.equal(declined.document.error?.code, 'HUMAN_REQUIRED', 'a declined fingerprint sends nothing');
  assert.equal(box.moveAcks.length, acks, 'nothing reached the relay');
  assert.equal(touch.opens().length, 1);
  touch.decline(false);

  const approved = await box.cli('spec', 'approve', 'G1');
  assert.equal(approved.code, 0, `the person approves from their own terminal on the linked board: ${JSON.stringify(approved.document)}`);
  assert.deepEqual(touch.opens().map((call) => call.args), [['open', 'Pullboard: approve spec rows G1 (pullboard spec approve)'], ['open', 'Pullboard: approve spec rows G1 (pullboard spec approve)']],
    'exactly one fingerprint per person move, prompting with the move and its ids');
  assert.equal(touch.calls().some((call) => call.args[0] === 'confirm'), false);
  const sent = box.moveAcks.slice(acks);
  assert.ok(sent.some((event) => event.sender?.kind === 'person'), 'the relay recorded the move as the person\'s');
  assert.deepEqual(approved.document.decisions?.map((record) => [record.id, record.decision, record.by, record.replacement]),
    [['G1', 'approve', 'person', '- G1 [approved, must] A row the person approves from the Mac | gate: review']],
    `the person's own decision is recorded: ${JSON.stringify(approved.document)}`);
});

test('policy.personPhoneOnly on keeps person moves on the paired phone, without asking for a fingerprint [B26,R1]', async (t) => {
  const box = await relayClientFixture(t);
  const touch = fakeTouchId(box);
  await box.link();
  writeFileSync(join(box.root, 'SPEC.md'), SPEC);
  assert.equal((await box.cli('relay', 'person', 'on')).code, 0);
  const set = await box.cli('settings', 'policy.personPhoneOnly', 'on', '--reason', 'the person wants the phone only');
  assert.equal(set.code, 0, JSON.stringify(set.document));
  const refused = await box.cli('spec', 'approve', 'G1');
  assert.equal(refused.document.error?.code, 'HUMAN_REQUIRED');
  assert.match(refused.document.error?.message ?? '', /personPhoneOnly/u);
  assert.equal(touch.opens().length, 0, 'no fingerprint is asked for while the board keeps person moves on the phone');
});

test('an agent terminal cannot sign the Mac in for person moves [B26]', async (t) => {
  const box = await relayClientFixture(t);
  const touch = fakeTouchId(box);
  await box.link();
  const agent = await relayFixtureChild(box.root, { ...box.env, CODEX_THREAD_ID: 'agent' }, [CLI, 'relay', 'person', 'on', '--json']);
  assert.equal(agent.document.error?.code, 'B26_PERSON_CHANNEL');
  assert.deepEqual(touch.calls(), [], 'nothing is sealed');
});

test('code an agent runs cannot reach the kept person sign-in, even past the commands\' own checks [B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  const touch = fakeTouchId(box);
  await box.link();
  assert.equal((await box.cli('relay', 'person', 'on')).code, 0);
  const relay = JSON.stringify(new URL('../src/relay.js', import.meta.url).href);
  const seats = JSON.stringify(new URL('../src/relay-seats.js', import.meta.url).href);
  const source = `
    import { relayOperation } from ${relay};
    import { actorTransport } from ${seats};
    const results = {};
    try { await relayOperation(process.cwd(), 'recordRowDecisions', [{ agentId: 'person', channel: 'terminal', decisions: [] }], { err() {} }); results.move = null; }
    catch (error) { results.move = error.code; }
    try { await actorTransport(process.cwd(), '', { board: 'x', url: 'http://127.0.0.1:9' }, 'person', { err() {} }); results.transport = null; }
    catch (error) { results.transport = error.code; }
    console.log(JSON.stringify(results));`;
  const agent = await relayFixtureChild(box.root, { ...box.env, CLAUDECODE: '1' }, ['--input-type=module', '-e', source]);
  assert.deepEqual(agent.document, { move: 'B26_PERSON_CHANNEL', transport: 'HUMAN_REQUIRED' },
    'a direct person move from an agent environment is refused, and no transport hands out the person session');
  assert.equal(touch.opens().length, 0, 'the sign-in was never unwrapped');
});

test('Touch ID in an agent terminal on a linked board sends the move with exactly one fingerprint [B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  const touch = fakeTouchId(box);
  await box.link();
  writeFileSync(join(box.root, 'SPEC.md'), SPEC);
  assert.equal((await box.cli('relay', 'person', 'on')).code, 0);
  assert.equal((await box.cli('settings', 'policy.personTouchId', 'on', '--reason', 'the person approves from agent terminals')).code, 0);
  const agentEnv = { ...box.env, CLAUDECODE: '1' };

  touch.decline(true);
  const acks = box.moveAcks.length;
  const declined = await relayFixtureChild(box.root, agentEnv, [CLI, 'spec', 'approve', 'G1', '--json']);
  assert.equal(declined.document.error?.code, 'B26_PERSON_CHANNEL', 'a declined fingerprint refuses');
  assert.equal(box.moveAcks.length, acks, 'a declined fingerprint sends nothing');
  touch.decline(false);

  const before = touch.calls().length;
  const approved = await relayFixtureChild(box.root, agentEnv, [CLI, 'spec', 'approve', 'G1', '--json']);
  assert.equal(approved.code, 0, `a fingerprint lets the agent terminal send it: ${JSON.stringify(approved.document)}`);
  assert.deepEqual(touch.calls().slice(before).map((call) => call.args), [['open', 'Pullboard: approve spec rows G1 (pullboard spec approve)']],
    'exactly one helper call, the unwrap, prompting with the move and its ids');
  assert.ok(box.moveAcks.slice(acks).some((event) => event.sender?.kind === 'person'), 'the relay recorded the move as the person\'s');
  assert.deepEqual(approved.document.decisions?.map((record) => [record.id, record.decision]), [['G1', 'approve']]);

  assert.equal((await box.cli('settings', 'policy.personPhoneOnly', 'on', '--reason', 'the person wants the phone only')).code, 0);
  const opens = touch.calls().length;
  const phoneOnly = await relayFixtureChild(box.root, agentEnv, [CLI, 'spec', 'decline', 'G1', '--reason', 'changed my mind', '--json']);
  assert.equal(phoneOnly.document.error?.code, 'HUMAN_REQUIRED', 'policy.personPhoneOnly keeps it on the phone');
  assert.equal(touch.calls().length, opens, 'no helper call while the board keeps person moves on the phone');
});
