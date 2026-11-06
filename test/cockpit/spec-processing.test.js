/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** A recorded Spec decision reads as processing, with its controls locked, until spec apply lands [B26,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../../src/person.js';
import { pageScriptPart4 } from '../../src/view/page-script-4.js';
import { machine, project, startView, openPage } from './fixture.js';

const spec = '# Processing\n\n## G · Goals\n'
  + '- G1 [draft, must] The first requirement. | gate: review\n'
  + '- G2 [draft, must] The second requirement. | gate: review\n'
  + '- G3 [approved, must] An approved requirement. | gate: review\n';

/** One rendered Spec list row by its id. */
const listRow = (html, id) => html.split('<div class="srow').slice(1).find((chunk) => chunk.includes(`data-row="spec:${id}"`)) ?? '';

/** Each decision button in a region as its word, disabled attribute and aria-disabled value. */
const controls = (html, selector) => [...html.matchAll(new RegExp(`<button[^>]*${selector}[^>]*>([^<]*)`, 'g'))]
  .map(([tag, word]) => ({ word: word.trim(), disabled: / disabled[ >]/.test(tag), aria: /aria-disabled="([^"]*)"/.exec(tag)?.[1] ?? null }));

test('a decision recorded on the board shows processing on every page and locks its controls until applied [B26,N26]', { timeout: 120_000 }, async () => { // budget: real Git and view setup plus three page loads; no performance claim.
  const box = machine();
  const demo = project(box, 'spec-processing', spec);
  const personEnv = { ...box.env };
  for (const name of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete personEnv[name];
  // Recorded from the command line, as another device would: this page never saw the press.
  box.runWithEnv(demo.repo, personEnv, 'spec', 'approve', 'G1');
  const view = await startView(box);
  try {
    let page = await openPage(view);
    // The page fixture has no window; a decision keeps the reading position through it.
    page.run('globalThis.window = { scrollY: 0, scrollTo() {} }');
    await page.click({ tab: 'spec' });
    const chips = page.show('spec-chips');
    assert.match(chips, /data-rows="spec:decide"[^>]*aria-busy="true"[^>]*>Needs your decision<b>1<\/b><span class="processing-count">1 processing…<\/span>/,
      'the Needs your decision filter counts the row still to decide and names the one processing');
    const list = page.show('spec-list');
    assert.match(listRow(list, 'G1'), /aria-busy="true"[^]*<span class="chip processing" title="approved, pending apply">Processing…<\/span>/, 'the recorded row stays under Needs your decision as processing');
    assert.doesNotMatch(listRow(list, 'G2'), /Processing|aria-busy/, 'the undecided row is not processing');
    assert.deepEqual(controls(list, 'data-section-approve'), [{ word: 'Approve all 1 in this section', disabled: false, aria: null }], 'Approve all names only the row left to decide');

    await page.click({ row: 'spec:G1' });
    assert.deepEqual(controls(page.show('spec-detail'), 'data-row-decision'), [{ word: 'Processing…', disabled: true, aria: 'true' }, { word: 'Decline', disabled: true, aria: 'true' }],
      'the processing row keeps its decision controls, disabled');
    const before = page.requests.length;
    await page.click({ rowDecision: 'approve', rowKind: 'spec', rowId: 'G1' });
    assert.equal(page.requests.slice(before).some((request) => request.method === 'POST'), false, 'a press on a locked control records nothing');

    await page.click({ row: 'spec:G2' });
    assert.deepEqual(controls(page.show('spec-detail'), 'data-row-decision').map(({ disabled }) => disabled), [false, false], 'the undecided row can still be decided');
    await page.click({ rowDecision: 'approve', rowKind: 'spec', rowId: 'G2' });
    assert.ok(page.requests.some((request) => request.method === 'POST' && request.body?.args?.ids === 'G2'), 'the page recorded G2');
    assert.match(listRow(page.show('spec-list'), 'G2'), /Processing…/, 'the row just decided reads as processing at once');
    assert.deepEqual(controls(page.show('spec-list'), 'data-section-approve'), [{ word: 'Processing 2…', disabled: true, aria: 'true' }], 'with every row of the section on its way, Approve all is locked');
    assert.match(page.show('spec-chips'), /<button data-rows="spec:decide"[^>]* disabled aria-disabled="true"[^>]*>Needs your decision<b>0<\/b><span class="processing-count">2 processing…<\/span>/,
      'with nothing left to decide the filter takes no press');

    // A reload reads the same wait back from the board.
    page = await openPage(view);
    await page.click({ tab: 'spec' });
    assert.match(listRow(page.show('spec-list'), 'G2'), /Processing…/, 'a reload still shows the decision processing');

    box.runWithEnv(demo.repo, personEnv, 'spec', 'apply');
    await page.run('seen = ""; refresh()');
    assert.doesNotMatch(page.show('spec-chips') + page.show('spec-list'), /Processing|aria-busy|processing-count/, 'once applied, nothing reads as processing');
    await page.click({ rows: 'spec:approved' });
    assert.ok(['G1', 'G2'].every((id) => listRow(page.show('spec-list'), id)), 'the applied rows move to Approved');
  } finally {
    await view.stop();
  }
});

test('a decision on its way locks its row and a failed one gives the controls back with the reason [B26,N26]', async () => {
  const served = pageScriptPart4({});
  const slice = (from, to) => { const start = served.indexOf(from), end = served.indexOf(to, start); assert.ok(start >= 0 && end > start, 'the test extracts ' + from); return served.slice(start, end); };
  const source = slice('function processingRows(', '\n}\n') + '\n}\n' + slice('async function decideRow(', '\n}\n\n/**\n * Run a public API move') + '\n}\n';
  let fail;
  const view = { root: 'repo', row: { spec: 'G1', doctrine: null } };
  const context = {
    snapshot: false, readOnly: false, requests: false, view, window: { scrollY: 0, scrollTo() {} }, innerHeight: 900,
    data: { project: { spec: [{ id: 'G1', status: 'draft' }, { id: 'G2', status: 'draft' }], practice: [], personRequests: [] } },
    $: () => ({ querySelectorAll: () => [] }), render() {}, setTimeout() {},
    pageMove: (command, args) => ({ body: { command, args } }), boardPath: () => '', moveMessage: () => 'recorded', refresh: async () => {},
    api: () => new Promise((_, reject) => { fail = reject; }),
  };
  vm.runInNewContext(source + 'this.processingRows = processingRows; this.decideRow = decideRow;', context);
  const pressed = context.decideRow('spec', 'spec-approve', { ids: 'G1' }, { closest: () => null });
  assert.deepEqual([...context.processingRows('spec')], ['G1'], 'the row is processing while its move is on the way');
  assert.equal(await context.decideRow('spec', 'spec-approve', { ids: 'G1' }, { closest: () => null }), false, 'a second press on the same row records nothing');
  fail(new Error('[BOARD_BUSY] The board is busy.'));
  assert.equal(await pressed, false);
  assert.deepEqual([...context.processingRows('spec')], [], 'a failed move gives the row its controls back');
  assert.deepEqual([view.specFeedback.tone, view.specFeedback.text], ['no', '[BOARD_BUSY] The board is busy.'], 'and says why beside it');
});

/** The production processingRows, run against a board projection with no decision on its way from this page. */
function processingOf(project) {
  const served = pageScriptPart4({});
  const start = served.indexOf('function processingRows('), end = served.indexOf('\n}\n', start) + 3;
  assert.ok(start >= 0 && end > start, 'the test extracts the production processingRows');
  const context = { view: { root: 'repo', specFeedback: null }, data: { project } };
  vm.runInNewContext(served.slice(start, end) + 'this.processingRows = processingRows;', context);
  return (kind) => [...context.processingRows(kind)].sort();
}

test('a phone request names its rows by spaces or commas, and an answer by its row [B26,N26]', () => {
  const waiting = (verb, args, sequence) => ({ id: 'r' + sequence, sequence, status: 'waiting', at: '2026-11-05T10:00:00.000Z', move: { verb, args } });
  const rows = processingOf({ spec: [], practice: [], personRequests: [
    waiting('spec-approve', { ids: 'G1,G2' }, 1), waiting('spec-decline', { ids: 'G3, G4 doctrine:D1', reason: 'no' }, 2), waiting('spec-answer', { row: 'G5', answer: 'yes' }, 3),
  ] });
  assert.deepEqual(rows('spec'), ['G1', 'G2', 'G3', 'G4', 'G5'], 'comma and space separated ids, and the answered row, all wait');
  assert.deepEqual(rows('doctrine'), ['D1'], 'a doctrine id keeps to Doctrine');
});

test('a refused request ends the wait its recorded decision would otherwise hold [B26,N26]', () => {
  const decision = { decision: 'approve', at: '2026-11-05T10:00:00.000Z' };
  const request = (id, status, extra) => ({ id, sequence: Number(id.slice(1)), status, at: '2026-11-05T09:59:00.000Z', move: { verb: 'spec-approve', args: { ids: 'G1' } }, ...extra });
  assert.deepEqual(processingOf({ spec: [{ id: 'G1', status: 'draft', decision }], practice: [], personRequests: [request('r1', 'refused', { resultSequence: 7 })] })('spec'), [],
    'the coordinator declined the request that recorded the decision, so nothing is processing');
  assert.deepEqual(processingOf({ spec: [{ id: 'G1', status: 'draft', decision }], practice: [], personRequests: [request('r1', 'refused', { at: '2026-11-05T10:01:00.000Z' })] })('spec'), [],
    'a refusal newer than the decision ends the wait too');
  assert.deepEqual(processingOf({ spec: [{ id: 'G1', status: 'draft', decision }], practice: [], personRequests: [request('r1', 'refused'), request('r2', 'done', { resultSequence: 9 })] })('spec'), ['G1'],
    'a later request that went through keeps the decision processing');
  assert.deepEqual(processingOf({ spec: [{ id: 'G1', status: 'draft', decision }], practice: [], personRequests: [request('r1', 'refused')] })('spec'), ['G1'],
    'an older refusal, before the decision was recorded, does not end it');
});

test('an answered question stays in Needs you as processing, and opens nothing [B26,N26]', { timeout: 120_000 }, async () => { // budget: real Git and view setup plus one page load; no performance claim.
  const box = machine();
  const demo = project(box, 'question-processing', '# Questions\n\n## G · Goals\n- G1 [pending, must] The board remembers the last tab: yes. Choices: yes, no. | gate: review\n- G2 [draft, must] A draft. | gate: review\n');
  const personEnv = { ...box.env };
  for (const name of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete personEnv[name];
  box.runWithEnv(demo.repo, personEnv, 'spec', 'answer', 'G1', 'no');
  box.runWithEnv(demo.repo, personEnv, 'spec', 'approve', 'G2');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const needs = page.show('needs');
    const question = needs.split('<li').find((row) => row.includes('remembers the last tab')) ?? '';
    assert.match(question, /aria-busy="true"[^]*Processing…/, 'the answered question reads as processing');
    assert.doesNotMatch(question, /data-go=/, 'and takes no press while it waits');
    assert.match(needs, /<li class="row ask"[^>]*aria-busy="true"[^>]*>[^]*<span>1<\/span>spec row processing, waiting on spec apply/, 'the approved draft is named as processing too');
  } finally {
    await view.stop();
  }
});
