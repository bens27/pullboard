/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/needs.js src/person-calls.js src/view/needs-list.js */
/** A verdict no seat may give and a row ready to sign are the person's calls too [B26,V1,S5]. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as store from '../src/board.js';
import { personNeeds } from '../src/needs.js';
import { personVerifies } from '../src/person-calls.js';
import { needsEntries, renderNeedsRow } from '../src/view/needs-list.js';
import { createE2eHelpers } from './e2e-helpers.js';

test('Needs you lists a verdict only the person can give and a row ready to sign [B26,V1,S5]', () => {
  const builder = runInNewContext(`(${personNeeds.toString()})`);
  const state = {
    personVerifies: [{ id: 7, title: 'Coordinator fix', commit: 'a'.repeat(40), at: '2026-11-05T10:00:00.000Z' },
      { id: 8, title: 'Already verified', commit: 'b'.repeat(40), at: '2026-11-05T10:00:00.000Z' }],
    signoffsDue: [{ id: 'G1', text: 'The page renders.', items: [3, 4] }],
    items: [{ id: 7, status: 'submitted', commit: 'a'.repeat(40) }, { id: 8, status: 'verified', commit: 'b'.repeat(40) }],
  };
  const needs = JSON.parse(JSON.stringify(builder(state)));
  assert.deepEqual(needs.map(need => [need.kind, need.id]), [['verify', 7], ['signoff', 'G1']],
    'an item the page already saw verified leaves the list');
  const [verify, signoff] = needs;
  assert.equal(verify.target, 'item:7');
  assert.match(verify.what, /^verify #7 at a{12}, or have a seat from another machine verify it$/u);
  assert.equal(signoff.target, 'spec:G1');
  assert.equal(signoff.what, 'pullboard spec signoff G1 --note "<what you checked>"');
  assert.match(signoff.text, /verified: #3, #4/u);
  assert.equal(builder({ personVerifies: state.personVerifies.slice(0, 1) }).length, 1, 'a state without items keeps every verify call');

  const rows = needsEntries(needs, []);
  const rendered = rows.map(row => renderNeedsRow((entry, kind, action) => ({ target: entry[0], kind, action }), () => null, row));
  assert.deepEqual(rendered, [
    { target: 'item:7', kind: verify.what, action: 'verify' },
    { target: 'spec:G1', kind: signoff.what, action: 'sign off' },
  ], 'the cockpit opens the item or row and shows the step beside its action');
});

test('a coordinator-built item on a linked board waits for the person to verify it [V1,B26]', (t) => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const ran = (cwd, ...args) => {
    const result = box.run(cwd, ...args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err || result.out}`);
    return result;
  };
  ran(box.repo, 'add', 'coordinator', 'Coordinator notes', '--criterion', 'the notes exist', '--check', 'test -f docs/notes.md');
  ran(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--criterion', 'the page exists', '--check', 'test -f web/index.html');
  ran(box.repo, 'claim', '1');
  mkdirSync(join(box.repo, 'docs'));
  writeFileSync(join(box.repo, 'docs/notes.md'), 'notes\n');
  box.git(box.repo, 'add', 'docs/notes.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs(notes): add notes');
  ran(box.repo, 'submit', '1');
  ran(box.web, 'claim', '2');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/index.html'), 'page\n');
  box.git(box.web, 'add', 'web/index.html');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): add page [G1]');
  ran(box.web, 'submit', '2');

  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const items = store.listItems(board, { all: true });
    assert.deepEqual(personVerifies(board, items, { linked: true }), [], 'with policy.verifierStanding off, a fresh seat here may verify the coordinator\'s work');
  } finally { store.closeBoard(board); }
  ran(box.repo, 'settings', 'policy.verifierStanding', 'on', '--reason', 'this board asks for relay standing');
  const standing = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const board = standing;
    const items = store.listItems(board, { all: true });
    assert.deepEqual(personVerifies(board, items, { linked: true }).map(item => item.id), [1],
      'every seat is refused the coordinator\'s work, while the web item has an independent verifier');
    assert.deepEqual(personVerifies(board, items, { linked: false }), [], 'unlinked, the coordinator can make an independent verifier');
    const needs = personNeeds({ personVerifies: personVerifies(board, items, { linked: true }) });
    assert.deepEqual(needs.map(need => [need.kind, need.ref]), [['verify', '#1']]);
  } finally { store.closeBoard(standing); }
});

test('a row whose items are all verified waits for the person to sign it off [S5,B26]', async (t) => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const ran = (cwd, ...args) => {
    const result = box.run(cwd, ...args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err || result.out}`);
    return result;
  };
  /** The person's sign-off calls, as resume lists them. */
  const signoffs = () => JSON.parse(ran(box.repo, 'resume', '--json').out).needsYou.filter(need => need.kind === 'signoff');
  ran(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--criterion', 'the page exists', '--check', 'test -f web/index.html');
  ran(box.web, 'claim', '1');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/index.html'), 'page\n');
  box.git(box.web, 'add', 'web/index.html');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): add page [G1]');
  ran(box.web, 'submit', '1');
  assert.deepEqual(signoffs(), [], 'a row still awaiting its verdict is not ready to sign');

  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const review = join(box.dir, 'review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  ran(review, 'join', 'api');
  ran(review, 'verify', '1', 'accept', '--note', 'web/index.html exists at the submitted commit');

  const due = signoffs();
  assert.deepEqual(due.map(need => [need.id, need.items]), [['G1', [1]]], 'G1 is ready; G2 has no verified work');
  assert.equal(due[0].what, 'pullboard spec signoff G1 --note "<what you checked>"');
  const { personNeedsState } = await import('../src/needs-state.js');
  assert.deepEqual(personNeeds(personNeedsState(box.repo)).filter(need => need.kind === 'signoff'), due,
    'the view and MCP state list the same call');
  assert.deepEqual(JSON.parse(ran(box.repo, 'status', '--json').out).needs.filter(need => need.kind === 'signoff'), due,
    'status counts it too');
  assert.match(ran(box.repo, 'resume').out, /needs the person: G1: .*pullboard spec signoff G1/u);
});

test('an open ask needs the person, with its steps and the command that records each one [B26]', () => {
  const builder = runInNewContext(`(${personNeeds.toString()})`);
  const ask = (id, status, done) => ({ id, title: 'Link <the> relay', why: 'Phones & "laptops" need it', from: 'b1', created: '2026-11-07T09:00:00.000Z',
    status, cwd: '/repo', personOnly: true, steps: [
      { n: 1, label: 'Sign in', command: 'pullboard relay on --all', prompts: [], done },
      { n: 2, label: 'Pair <phone>', command: 'pullboard relay join {code}', prompts: ['code'], done: false }] });
  const state = { asks: [ask(3, 'open', true), ask(4, 'done', true), ask(5, 'dropped', false)],
    agents: [{ agent_id: 'b1', displayName: 'builder one' }] };
  const needs = JSON.parse(JSON.stringify(builder(state)));
  assert.deepEqual(needs.map(need => [need.kind, need.id]), [['ask', 'ask:3']], 'a finished or dropped ask leaves the list');
  const [need] = needs;
  assert.equal(need.from, 'builder one');
  assert.equal(need.what, 'pullboard relay join {code}', 'the next step keeps its placeholder as written');
  assert.equal(need.done, 'pullboard ask done 3 --step 2 --as person');

  const html = renderNeedsRow(() => 'standard row', () => null, needsEntries(needs, [])[0]);
  assert.doesNotMatch(html, /<the>|<phone>|& "laptops"/u, 'agent-written text is escaped');
  assert.match(html, /Link &lt;the&gt; relay/u);
  assert.match(html, /Phones &amp; &quot;laptops&quot; need it/u);
  assert.match(html, /builder one/u);
  assert.ok(html.indexOf('Sign in') < html.indexOf('Pair &lt;phone&gt;'), 'steps show in order');
  assert.match(html, /<code>pullboard relay join \{code\}<\/code>/u);
  assert.match(html, /data-copy="pullboard ask done 3 --step 2 --as person"/u, 'the person copies the command that records the step');
  assert.doesNotMatch(html, /data-run|data-act/u, 'the browser view never runs a step');
});
