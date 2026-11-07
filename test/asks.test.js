/** Asks are board records the person works through in order, and pullboard needs lists them with board needs [B26,N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { needsList } from '../src/needs-steps.js';
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
  assert.equal(filed.id, 1);
  assert.equal(filed.status, 'open');
  assert.deepEqual(filed.steps.map(step => step.prompts), [[{ key: 'path', label: 'path', default: '' }], []]);
  const web = filed.from;

  let needs = run(box, box.repo, 'needs', '--json');
  assert.equal(needs.version, 1);
  assert.equal(needs.root, box.repo);
  const ask = needs.needs.find(need => need.id === 'ask:1');
  assert.equal(ask.source, 'ask');
  assert.equal(ask.from, web);
  assert.equal(ask.next, 1);
  assert.deepEqual(ask.steps.map(step => [step.n, step.cwd, step.personOnly, step.done]), [[1, box.repo, true, false], [2, box.repo, true, false]]);
  assert.match(run(box, box.repo, 'needs'), /ask:1 {2}Rotate the deploy key {2}\(from .+\)\n {2}step 1\/2: ssh-keygen -f \{path\}/u);

  run(box, box.repo, 'ask', 'done', '1', '--note', 'made it');
  needs = run(box, box.repo, 'needs', '--json');
  assert.equal(needs.needs.find(need => need.id === 'ask:1').next, 2);
  assert.deepEqual(shoutsTo(box, web), [], 'a step done is not news for the filer');

  assert.equal(box.run(box.repo, 'ask', 'done', '1', '--step', '1').code, 1, 'a done step cannot be done again');
  run(box, box.repo, 'ask', 'done', 'ask:1', '--step', '2');
  needs = run(box, box.repo, 'needs', '--json');
  assert.equal(needs.needs.some(need => need.id === 'ask:1'), false, 'a finished ask leaves the list');
  assert.deepEqual(shoutsTo(box, web), ['Ask 1 done: Rotate the deploy key']);
  assert.equal(box.run(box.repo, 'ask', 'done', '1').code, 1, 'a closed ask stays closed');
});

test('only the filer or the coordinator drops an ask, with a reason [B26]', () => {
  const box = helpers.project('true');
  const other = join(box.dir, 'second');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', other, 'HEAD');
  run(box, other, 'join', 'api', '--model', 'fixture-asks');
  run(box, box.web, 'ask', 'Check the phone', '--step', 'Open it::open https://example.invalid', '--cwd', box.dir);
  assert.equal(run(box, box.web, 'needs', '--json').needs.find(need => need.id === 'ask:1').steps[0].cwd, box.dir);
  const refused = box.run(other, 'ask', 'drop', '1', '--reason', 'not mine', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'ASK_NOT_FILER');
  assert.equal(JSON.parse(box.run(box.repo, 'ask', 'drop', '1', '--json').out).error.code, 'BAD_ASK');
  const dropped = run(box, box.repo, 'ask', 'drop', '1', '--reason', 'done another way', '--json').ask;
  assert.equal(dropped.status, 'dropped');
  assert.deepEqual(shoutsTo(box, dropped.from), ['Ask 1 dropped: Check the phone\nReason: done another way']);
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

test('a step with a placeholder may not quote, escape or substitute around it; ${x} is not a placeholder [B26]', () => {
  const box = helpers.project('true');
  const refused = ["echo '{note}'", 'echo "a {note}"', 'echo "\\{note}"', 'echo "$(printf "%s" "{note}")"', 'echo "$(echo " {note} ")"',
    'echo \\{note}', 'echo $(echo {note})', 'echo `echo {note}`', "echo it's {note}'"];
  for (const command of refused) {
    const result = box.run(box.web, 'ask', 'Quoted', '--step', `Say it::${command}`, '--json');
    assert.notEqual(result.code, 0, command);
    assert.equal(JSON.parse(result.out).error.code, 'ASK_QUOTED_PLACEHOLDER', command);
  }
  const filed = run(box, box.web, 'ask', 'Bare', '--step', "Say it::echo {note} ${HOME} '{x' 'a b'", '--step', 'Plain::echo "no keys" $(date)', '--json').ask;
  assert.deepEqual(filed.steps.map(step => step.prompts.map(prompt => prompt.key)), [['note'], []]);
});
