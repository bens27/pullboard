/** On a linked board the person's own Mac counts as the person, while agent terminals stay refused [B26,H16]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture, relayFixtureChild } from './relay-client-fixture.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');
const SPEC = '# Mac person fixture spec\n\n## G · Goals\n\n- G1 [draft, must] A row the person approves from the Mac | gate: review\n';

/**
 * A stand-in for macOS `security` on the fixture's private PATH, so no test reaches the real keychain.
 * It keeps items in a file beside itself, records every argv (never stdin), and answers a secret read
 * only as the real tool would after the person confirms, or refuses when the test says the person declined.
 */
function fakeSecurity(directory) {
  const store = join(directory, '..', 'fake-keychain.json');
  const log = join(directory, '..', 'fake-keychain-log.jsonl');
  writeFileSync(join(directory, 'security'), `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const store = ${JSON.stringify(store)}, log = ${JSON.stringify(log)};
const items = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {};
const save = () => writeFileSync(store, JSON.stringify(items));
appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const option = (args, name) => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const options = (args, name) => args.flatMap((value, at) => args[at - 1] === name ? [value] : []);
/** Split one interactive line as security -i does: spaces, double quotes and backslashes. */
function split(line) {
  const out = []; let word = null; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '\\\\') { word = (word ?? '') + line[++i]; continue; }
    if (c === '"') { quoted = !quoted; word ??= ''; continue; }
    if (!quoted && /\\s/.test(c)) { if (word !== null) out.push(word); word = null; continue; }
    word = (word ?? '') + c;
  }
  if (word !== null) out.push(word);
  return out;
}
function run(args) {
  const key = option(args, '-s') + '|' + option(args, '-a');
  if (args[0] === 'list-keychains') { console.log('"/fake/login.keychain-db"'); return 0; }
  if (args[0] === 'delete-generic-password') { if (!items[key]) return 44; delete items[key]; save(); return 0; }
  if (args[0] === 'add-generic-password') {
    if (items[key] && !args.includes('-U')) return 45;
    items[key] = { secret: option(args, '-w'), trusted: options(args, '-T'), label: option(args, '-l') }; save(); return 0;
  }
  if (args[0] === 'find-generic-password') {
    if (!items[key]) return 44;
    if (!args.includes('-w')) { console.log('keychain: "/fake/login.keychain-db"'); return 0; }
    // Every trusted-app-free read is one the real tool asks the person to allow.
    appendFileSync(log, JSON.stringify(['(person asked to allow)']) + '\\n');
    if (existsSync(store + '.decline')) return 128;
    console.log(items[key].secret); return 0;
  }
  return 1;
}
if (process.argv[2] === '-i') {
  let input = '';
  process.stdin.setEncoding('utf8').on('data', (part) => { input += part; }).on('end', () => {
    let status = 0;
    for (const line of input.split('\\n').filter(Boolean)) status = run(split(line));
    process.exit(status);
  });
} else process.exit(run(process.argv.slice(2)));
`, { mode: 0o700 });
  chmodSync(join(directory, 'security'), 0o700);
  return {
    items: () => existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {},
    argv: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [],
    reads: () => (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter((line) => line.includes('(person asked to allow)')).length,
    decline: (value) => { if (value) writeFileSync(store + '.decline', ''); else rmSync(store + '.decline', { force: true }); },
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

test('the person\'s own Mac approves a row on a linked board, and an agent terminal still cannot [B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  const keychain = fakeSecurity(box.env.PATH);
  await box.link();
  writeFileSync(join(box.root, 'SPEC.md'), SPEC);

  // Before the person signs this Mac in, a linked board still sends person moves to the phone.
  const unsigned = await box.cli('spec', 'approve', 'G1');
  assert.equal(unsigned.document.error?.code, 'HUMAN_REQUIRED', 'no Mac sign-in: the paired phone is still the way');
  assert.equal(keychain.reads(), 0, 'no keychain read without a stored sign-in being asked for');

  const signed = await box.cli('relay', 'person', 'on');
  assert.equal(signed.code, 0, `the person signs this Mac in from their own terminal: ${JSON.stringify(signed.document)}`);
  const items = Object.values(keychain.items());
  assert.equal(items.length, 1, 'one keychain item holds the person sign-in');
  assert.match(items[0].secret, /^ps_[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(items[0].trusted, [''], 'the item trusts no app, so macOS asks the person before any read');
  assert.equal(keychain.argv().some((argv) => argv.some((value) => /ps_[A-Za-z0-9_-]{43}/u.test(value))), false,
    'the session never appears in a process argument list');
  for (const directory of [box.env.HOME, join(box.root, '.git')]) assert.equal(holdsPersonSession(directory), false, `no file under ${directory} holds the session`);
  assert.equal(JSON.stringify(signed.document).includes(items[0].secret), false, 'the command never prints the session');

  // An agent's terminal is refused before the keychain is touched.
  const reads = keychain.reads();
  const agent = await relayFixtureChild(box.root, { ...box.env, CLAUDECODE: '1' }, [CLI, 'spec', 'approve', 'G1', '--json']);
  assert.equal(agent.document.error?.code, 'B26_PERSON_CHANNEL', 'an agent terminal stays refused');
  assert.equal(keychain.reads(), reads, 'an agent terminal never asks for the person sign-in');

  // The person declining the keychain prompt records nothing.
  keychain.decline(true);
  const declined = await box.cli('spec', 'approve', 'G1');
  assert.equal(declined.document.error?.code, 'HUMAN_REQUIRED', 'a declined keychain prompt sends nothing');
  assert.equal(keychain.reads(), reads + 1);
  keychain.decline(false);

  const acks = box.moveAcks.length;
  const approved = await box.cli('spec', 'approve', 'G1');
  assert.equal(approved.code, 0, `the person approves from their own terminal on the linked board: ${JSON.stringify(approved.document)}`);
  assert.equal(keychain.reads(), reads + 2, 'exactly one keychain read, so one prompt, per person move');
  const sent = box.moveAcks.slice(acks);
  assert.ok(sent.some((event) => event.sender?.kind === 'person'), 'the relay recorded the move as the person\'s');
  assert.deepEqual(approved.document.decisions?.map((record) => [record.id, record.decision, record.by, record.replacement]),
    [['G1', 'approve', 'person', '- G1 [approved, must] A row the person approves from the Mac | gate: review']],
    `the person's own decision is recorded: ${JSON.stringify(approved.document)}`);
});

test('policy.personPhoneOnly on keeps person moves on the paired phone, without asking the keychain [B26,R1]', async (t) => {
  const box = await relayClientFixture(t);
  const keychain = fakeSecurity(box.env.PATH);
  await box.link();
  writeFileSync(join(box.root, 'SPEC.md'), SPEC);
  assert.equal((await box.cli('relay', 'person', 'on')).code, 0);
  const set = await box.cli('settings', 'policy.personPhoneOnly', 'on', '--reason', 'the person wants the phone only');
  assert.equal(set.code, 0, JSON.stringify(set.document));
  const refused = await box.cli('spec', 'approve', 'G1');
  assert.equal(refused.document.error?.code, 'HUMAN_REQUIRED');
  assert.match(refused.document.error?.message ?? '', /personPhoneOnly/u);
  assert.equal(keychain.reads(), 0, 'the keychain is never asked while the board keeps person moves on the phone');
});

test('an agent terminal cannot sign the Mac in for person moves [B26]', async (t) => {
  const box = await relayClientFixture(t);
  const keychain = fakeSecurity(box.env.PATH);
  await box.link();
  const agent = await relayFixtureChild(box.root, { ...box.env, CODEX_THREAD_ID: 'agent' }, [CLI, 'relay', 'person', 'on', '--json']);
  assert.equal(agent.document.error?.code, 'B26_PERSON_CHANNEL');
  assert.deepEqual(keychain.items(), {}, 'nothing is stored');
});

test('code an agent runs cannot reach the kept person sign-in, even past the commands\' own checks [B26,H16]', async (t) => {
  const box = await relayClientFixture(t);
  const keychain = fakeSecurity(box.env.PATH);
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
  assert.equal(keychain.reads(), 0, 'the keychain was never asked');
});
