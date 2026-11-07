/** Asks are board records the person works through in order, and pullboard needs lists them with board needs [B26,N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { recordAsk } from '../src/asks.js';
import { needsList } from '../src/needs-steps.js';
import { projectState } from '../src/serve.js';
import { createE2eHelpers } from './e2e-helpers.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Run a real CLI command, keeping its refusal text when it fails. */
function run(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return args.includes('--json') ? JSON.parse(result.out) : result.out;
}

/** Read the inbox entries the web seat would see, without acknowledging them. */
function shoutsTo(box, agent) {
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return board.db.prepare('SELECT shout_text FROM shout WHERE shout_to = ?').all(agent).map(row => row.shout_text); }
  finally { store.closeBoard(board); }
}

test('a seat files an ask, the person finishes it step by step, and the filer hears once [B26]', () => {
  const box = helpers.project('true');
  const filed = run(box, box.web, 'ask', 'Rotate the deploy key', '--step', 'Make the key::ssh-keygen -f {path}',
    '--step', 'Approve it::pullboard spec approve G1', '--why', 'the old key leaked', '--person-only', '--json').ask;
  assert.match(filed.id, /^[0-9a-f]{8}$/u);
  const id = filed.id;
  assert.equal(filed.status, 'open');
  assert.deepEqual(filed.steps.map(step => step.prompts), [[{ key: 'path', label: 'path', default: '' }], []]);
  const web = filed.from;

  let needs = run(box, box.repo, 'needs', '--json');
  assert.equal(needs.version, 1);
  assert.equal(needs.root, box.repo);
  const ask = needs.needs.find(need => need.id === `ask:${id}`);
  assert.equal(ask.source, 'ask');
  assert.equal(ask.from, web);
  assert.equal(ask.next, 1);
  assert.deepEqual(ask.steps.map(step => [step.n, step.cwd, step.personOnly, step.done]), [[1, box.repo, true, false], [2, box.repo, true, false]]);
  assert.match(run(box, box.repo, 'needs'), new RegExp(String.raw`ask:${id} {2}Rotate the deploy key {2}\(from .+\)\n {2}step 1/2: ssh-keygen -f \{path\}`, 'u'));

  run(box, box.repo, 'ask', 'done', id, '--note', 'made it', '--as', 'person');
  needs = run(box, box.repo, 'needs', '--json');
  assert.equal(needs.needs.find(need => need.id === `ask:${id}`).next, 2);
  assert.deepEqual(shoutsTo(box, web), [], 'a step done is not news for the filer');

  assert.equal(box.run(box.repo, 'ask', 'done', id, '--step', '1').code, 1, 'a done step cannot be done again');
  run(box, box.repo, 'ask', 'done', `ask:${id}`, '--step', '2', '--as', 'person');
  needs = run(box, box.repo, 'needs', '--json');
  assert.equal(needs.needs.some(need => need.id === `ask:${id}`), false, 'a finished ask leaves the list');
  assert.deepEqual(shoutsTo(box, web), [`Ask ${id} done: Rotate the deploy key`]);
  assert.equal(box.run(box.repo, 'ask', 'done', id).code, 1, 'a closed ask stays closed');
});

test('only the filer or the coordinator drops an ask, with a reason [B26]', () => {
  const box = helpers.project('true');
  const other = join(box.dir, 'second');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', other, 'HEAD');
  run(box, other, 'join', 'api', '--model', 'fixture-asks');
  const { id } = run(box, box.web, 'ask', 'Check the phone', '--step', 'Open it::open https://example.invalid', '--cwd', box.dir, '--json').ask;
  assert.equal(run(box, box.web, 'needs', '--json').needs.find(need => need.id === `ask:${id}`).steps[0].cwd, box.dir);
  const refused = box.run(other, 'ask', 'drop', id, '--reason', 'not mine', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'ASK_NOT_FILER');
  assert.equal(JSON.parse(box.run(box.repo, 'ask', 'drop', id, '--json').out).error.code, 'BAD_ASK');
  const dropped = run(box, box.repo, 'ask', 'drop', id, '--reason', 'done another way', '--json').ask;
  assert.equal(dropped.status, 'dropped');
  assert.deepEqual(shoutsTo(box, dropped.from), [`Ask ${id} dropped: Check the phone\nReason: done another way`]);
  assert.equal(JSON.parse(box.run(box.web, 'ask', 'No steps', '--json').out).error.code, 'BAD_ASK');
});

test('board needs map to their commands with prompts, decisions once, and spec apply [B26,N26]', () => {
  const needs = needsList({ root: '/repo',
    needs: [
      { kind: 'signoff', id: 'G9', text: 'Signed rows (verified: #3)', what: 'pullboard spec signoff G9 --note "<what you checked>"' },
      { kind: 'decision', id: 12, text: 'Ship it?\nmore', at: '2026-11-07T00:00:00.000Z' },
      { kind: 'hold', id: 'web', text: 'paused', what: 'lane held by coordinator' },
      { kind: 'verify', id: 4, text: 'Thing: no seat may verify it', what: 'verify #4 at abc' },
    ],
    personQuestions: [{ id: 12, question: 'Ship it?' }, { id: 13, question: 'Rename?', at: null }],
    pendingApply: [{ id: 'G2', kind: 'row', decision: 'approve' }],
    openDecisions: [{ id: 20, asker: 'web-1', question: 'Which port?' }] });
  assert.deepEqual(needs.map(need => need.id), ['signoff:G9', 'decision:12', 'hold:web', 'verify:4', 'decision:13', 'apply', 'question:20']);
  const [signoff, decision, hold, verify] = needs;
  assert.deepEqual(signoff.steps, [{ n: 1, label: 'Sign G9', command: 'pullboard spec signoff G9 --note {note}', cwd: '/repo',
    prompts: [{ key: 'note', label: 'What you checked', default: '' }], personOnly: true, done: false }]);
  assert.equal(decision.title, 'Ship it?');
  assert.equal(decision.steps[0].command, 'pullboard answer 12 {answer} --as person');
  assert.equal(hold.steps[0].personOnly, false);
  assert.deepEqual([verify.steps, verify.next, verify.why], [[], null, 'verify #4 at abc']);
  assert.equal(needs[5].steps[0].command, 'pullboard spec apply');
  assert.equal(needs[6].steps[0].command, 'pullboard answer 20 {answer}');
});

test('a step with a placeholder takes it as a bare word among plain characters only; a step without one is free [B26]', () => {
  const box = helpers.project('true');
  const refused = ["echo '{note}'", 'echo "a {note}"', 'echo "\\{note}"', 'echo "$(printf "%s" "{note}")"', 'echo "$(echo " {note} ")"',
    'echo \\{note}', 'echo $(echo {note})', 'echo `echo {note}`', "echo it's {note}'",
    'print -r -- ${(eQ):-{note}}', 'echo ok # {note}', 'cat <<< {note}', '--x={note}'];
  for (const command of refused) {
    const result = box.run(box.web, 'ask', 'Quoted', '--step', `Say it::${command}`, '--json');
    assert.notEqual(result.code, 0, command);
    assert.equal(JSON.parse(result.out).error.code, 'ASK_QUOTED_PLACEHOLDER', command);
    assert.ok(JSON.parse(result.out).error.message.endsWith(`in: ${command}`), command);
  }
  const filed = run(box, box.web, 'ask', 'Bare', '--step', 'Join::pullboard relay join {code}', '--step', 'Plain::echo "no keys" ${HOME} $(date)', '--json').ask;
  assert.deepEqual(filed.steps.map(step => step.prompts.map(prompt => prompt.key)), [['code'], []]);
});

test('an ask keeps the random id its command chose, and the move refuses a malformed or reused one [B26]', () => {
  const box = helpers.project('true');
  const first = run(box, box.web, 'ask', 'One', '--step', 'Go::true', '--json').ask;
  const second = run(box, box.web, 'ask', 'Two', '--step', 'Go::true', '--json').ask;
  assert.notEqual(first.id, second.id);
  assert.equal(JSON.parse(box.run(box.repo, 'ask', 'done', '1', '--json').out).error.code, 'BAD_ASK', 'a position is not an id');
  assert.equal(JSON.parse(box.run(box.repo, 'ask', 'done', 'ffffffff', '--json').out).error.code, 'NO_ASK');
  run(box, box.repo, 'ask', 'drop', first.id, '--reason', 'not needed');
  assert.deepEqual(run(box, box.repo, 'needs', '--json').needs.filter(need => need.kind === 'ask').map(need => need.id), [`ask:${second.id}`]);
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const ask = { title: 'Direct', cwd: box.repo, steps: [{ label: 'Go', command: 'true' }] };
    for (const id of [undefined, '1', 'ABCDEF12', second.id]) {
      assert.throws(() => recordAsk(board, { agentId: store.PERSON, action: 'file', id, ask }), { code: 'BAD_ASK' }, String(id));
    }
  } finally { store.closeBoard(board); }
});

test('the person alone finishes a person-only ask; the filer, coordinator or person finishes any other [B26]', () => {
  const box = helpers.project('true');
  const other = join(box.dir, 'second');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', other, 'HEAD');
  run(box, other, 'join', 'api', '--model', 'fixture-asks');
  const code = (cwd, ...args) => JSON.parse(box.run(cwd, ...args, '--json').out).error?.code ?? 'ok';
  const only = run(box, box.web, 'ask', 'Mine', '--step', 'A::true', '--step', 'B::true', '--step', 'C::true', '--person-only', '--json').ask.id;
  assert.equal(code(box.web, 'ask', 'done', only), 'ASK_PERSON_ONLY', 'the filer is not the person');
  assert.equal(code(box.repo, 'ask', 'done', only), 'ASK_PERSON_ONLY', 'the coordinator is not the person');
  assert.equal(code(other, 'ask', 'done', only, '--as', 'person'), 'B26_PERSON_ANSWER', 'only the main checkout acts as the person');
  const done = run(box, box.repo, 'ask', 'done', only, '--as', 'person', '--json').ask;
  assert.equal(done.steps[0].doneBy, store.PERSON);
  const open = run(box, box.web, 'ask', 'Any', '--step', 'A::true', '--step', 'B::true', '--step', 'C::true', '--json').ask.id;
  assert.equal(code(other, 'ask', 'done', open), 'ASK_NOT_FILER');
  const steps = [run(box, box.web, 'ask', 'done', open, '--json'), run(box, box.repo, 'ask', 'done', open, '--json'),
    run(box, box.repo, 'ask', 'done', open, '--as', 'person', '--json')].map(result => result.ask);
  assert.equal(steps.at(-1).status, 'done');
  assert.deepEqual(steps.at(-1).steps.map(step => step.doneBy), [steps[0].from, 'coordinator', store.PERSON]);
});

test('a step is marked done only when every step before it is [B26]', () => {
  const box = helpers.project('true');
  const id = run(box, box.web, 'ask', 'Ordered', '--step', 'A::true', '--step', 'B::true', '--step', 'C::true', '--json').ask.id;
  const code = (...args) => JSON.parse(box.run(box.web, 'ask', 'done', id, ...args, '--json').out).error?.code ?? 'ok';
  assert.equal(code('--step', '2'), 'BAD_ASK', 'step 2 before step 1');
  assert.equal(code('--step', '1'), 'ok');
  assert.equal(code('--step', '3'), 'BAD_ASK', 'step 3 before step 2');
  assert.equal(code('--step', '2'), 'ok');
  assert.equal(code(), 'ok', 'no --step takes the next one');
});

test('the view state carries an open ask into Needs you until its last step is done [B26]', () => {
  const box = helpers.project('true');
  run(box, box.web, 'ask', 'Pair the phone', '--step', 'Pair::pullboard relay join {code}', '--json');
  const asked = projectState(box.repo).needs.filter(need => need.kind === 'ask');
  assert.deepEqual(asked.map(need => [need.id, need.what, need.done]), [['ask:1', 'pullboard relay join {code}', 'pullboard ask done 1 --step 1']]);
  run(box, box.repo, 'ask', 'done', '1', '--step', '1');
  assert.deepEqual(projectState(box.repo).needs.filter(need => need.kind === 'ask'), [], 'a finished ask leaves the view');
});
