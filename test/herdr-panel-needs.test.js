/**
 * The Herdr panel's Needs you model reads `pullboard needs --json`, fills a step's prompts
 * shell-quoted and builds the tab a confirmed step runs in [B26].
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  NEEDS_SPACE,
  askId,
  fillCommand,
  launchCommand,
  planRun,
  readNeeds,
  runnableStep,
  shellQuote,
  stepScript,
  stepStates,
} from '../integrations/herdr-app/mods/pullboard/needs-model.js';
import {
  BatchFlow,
  batchEntries,
  batchScript,
  planBatch,
  selectable,
  toggleNeed,
} from '../integrations/herdr-app/mods/pullboard/needs-batch.js';

const FIXTURE = readFileSync(new URL('../integrations/herdr-app/mods/pullboard/test/needs.json', import.meta.url), 'utf8');
const ok = (stdout) => ({ code: 0, stdout, stderr: '' });

/** What /bin/sh prints for `printf %s <quoted>`, so quoting is judged by a real shell. */
function shellSees(command) {
  return spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' }).stdout;
}

test('a value with quotes, $() and newlines reaches the command as one literal word [B26]', () => {
  const nasty = "it's $(touch /tmp/x) `id` \"q\" ;\nrm -rf ~ $HOME";
  assert.equal(shellSees('printf %s ' + shellQuote(nasty)), nasty);
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote(''), "''");
});

test('placeholders fill from answers, then defaults; a step without one stays as written [B26]', () => {
  const step = { command: 'pullboard spec signoff G9 --by BS --note {note} --as {who}', prompts: [{ key: 'note', default: 'n/a' }, { key: 'who', default: 'me' }] };
  assert.equal(fillCommand(step, { note: "Ben's check" }), "pullboard spec signoff G9 --by BS --note 'Ben'\\''s check' --as 'me'");
  assert.equal(fillCommand({ command: 'pullboard relay join {code}', prompts: [{ key: 'code' }] }, { code: 'ab-12' }), "pullboard relay join 'ab-12'");
  assert.equal(fillCommand({ command: "awk '{print}' {other} ${who}", prompts: [{ key: 'note' }] }), "awk '{print}' {other} ${who}");
  assert.equal(shellSees('printf "%s|" ' + fillCommand({ command: '{a} {a}', prompts: [{ key: 'a' }] }, { a: 'x y' })), 'x y|x y|');
});

test('a placeholder that is not a bare word among plain characters is refused, not filled [B26]', () => {
  const evil = '$(printf INJECTED)';
  const refused = [
    "printf '%s' '{note}'", 'printf "%s" "{note}"', 'echo "a {note}"', 'echo "\\{note}"',
    '"$(printf "%s" "{note}")"', '"$(echo " {note} ")"', '\\{note}', '$(echo {note})', 'echo `{note}`',
    "echo \\'{note}",
    'cat <<EOF\n{note}\nEOF', 'cat <<-EOF\r{note}', 'cat <<< {note}', 'echo {note}\necho done',
    'echo ok # {note}', 'echo {note}#',
    'print -r -- ${(eQ):-{note}}', '--x={note}', 'echo {note} ${HOME}', "echo {note} '{x'", 'echo {note} {other}', 'echo\t{note}',
  ];
  for (const command of refused) {
    assert.throws(() => fillCommand({ command, prompts: [{ key: 'note' }] }, { note: evil }), /cannot be filled safely/, command);
  }
  assert.equal(shellSees(fillCommand({ command: 'printf %s {note}', prompts: [{ key: 'note' }] }, { note: evil })), evil);
  assert.equal(fillCommand({ command: 'echo "$(date)" {other}', prompts: [{ key: 'note' }] }), 'echo "$(date)" {other}');
  const need = { id: 'ask:3f9a0c12', next: 1, steps: [{ n: 1, cwd: '/tmp', command: "echo '{note}'", prompts: [{ key: 'note' }] }] };
  assert.match(planRun({ need, n: 1, values: { note: 'x' }, spaces: [] }).refused, /cannot be filled safely/);
});

test('an answer with a line break or NUL is refused before filling, since prompts are one line [B26]', () => {
  const step = { command: 'echo ok {note}', prompts: [{ key: 'note' }] };
  for (const note of ['\ntouch /tmp/x\n#', 'a\rb', 'a\0b']) {
    assert.throws(() => fillCommand(step, { note }), /answer for \{note\} must be one line/, JSON.stringify(note));
  }
  assert.throws(() => fillCommand({ command: 'echo {note}', prompts: [{ key: 'note', default: 'a\nb' }] }), /must be one line/);
  const need = { id: 'ask:3f9a0c12', next: 1, steps: [{ n: 1, cwd: '/tmp', ...step }] };
  assert.match(planRun({ need, n: 1, values: { note: '\ntouch /tmp/x\n#' }, spaces: [] }).refused, /must be one line/);
});

test('the fixture reads as needs; a pullboard without the command is missing, not an error [B26]', () => {
  const read = readNeeds(ok(FIXTURE));
  assert.equal(read.state, 'ok');
  assert.deepEqual(read.needs.map((n) => n.id), ['signoff:G9', 'ask:3f9a0c12']);
  const missing = { version: 1, error: { code: 'USAGE', message: 'pullboard: no command "needs"; closest match is "next".' } };
  assert.deepEqual(readNeeds({ code: 2, stdout: JSON.stringify(missing), stderr: '' }), { state: 'missing' });
  assert.equal(readNeeds({ code: 1, stdout: '', stderr: 'boom\nmore' }).message, 'needs: exit 1: boom');
  assert.equal(readNeeds(ok('not json')).state, 'error');
  assert.deepEqual(readNeeds(ok('{"version":1,"root":"/r","needs":[]}')), { state: 'ok', root: '/r', needs: [] });
});

test('steps go in order: only the next step can run [B26]', () => {
  const ask = readNeeds(ok(FIXTURE)).needs[1];
  assert.deepEqual(stepStates(ask).map((s) => s.state), ['done', 'next', 'later']);
  assert.equal(runnableStep(ask, 2).label, 'Link every board');
  assert.equal(runnableStep(ask, 1), null);
  assert.equal(runnableStep(ask, 3), null);
  assert.equal(runnableStep({ ...ask, next: null }, 2), null);
  assert.match(planRun({ need: ask, n: 3, values: {}, spaces: [] }).refused, /not the next step/);
});

test('a step opens a tab in the Needs you space, making the space when missing [B26]', () => {
  const launch = { name: 'S', cwd: '/b', script: 'true' };
  const made = launchCommand([{ id: 's1', name: 'other', named: true, machine: null }], launch);
  assert.deepEqual(made, { command: 'space.new', args: { name: NEEDS_SPACE, folder: '/b', tab: 'S', argv: ['/bin/zsh', '-lc', 'true'], machine: '' } });
  const remote = { id: 'vps/s3', name: NEEDS_SPACE, named: true, machine: 'vps' };
  assert.equal(launchCommand([remote], launch).command, 'space.new');
  const reused = launchCommand([remote, { id: 's2', name: NEEDS_SPACE, named: true, machine: null }], launch);
  assert.deepEqual(reused, { command: 'tab.new', args: { space: 's2', name: 'S', folder: '/b', argv: ['/bin/zsh', '-lc', 'true'] } });
});

test('a confirmed ask step marks itself done only when its command exits 0 [B26]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-needs-'));
  try {
    const log = join(dir, 'calls');
    writeFileSync(join(dir, 'pullboard'), `#!/bin/sh\necho "$PWD $*" >> '${log}'\n`);
    chmodSync(join(dir, 'pullboard'), 0o755);
    // The tab's closing interactive shell is left out so the script ends in the test.
    const run = (command) => spawnSync('/bin/zsh', ['-fc', stepScript({ command, askId: '3f9a0c12', step: 2, root: dir }).replace(/\nexec .*$/, '')],
      { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin` } });
    const failed = run('exit 4');
    assert.match(failed.stdout, /\[exit 4\]/);
    assert.throws(() => readFileSync(log, 'utf8'));
    const passed = run('echo hi');
    assert.match(passed.stdout, /hi\n\n\[exit 0\]/);
    assert.equal(readFileSync(log, 'utf8'), `${dir} ask done 3f9a0c12 --step 2 --as person\n`);
    assert.doesNotMatch(stepScript({ command: 'true', askId: null, step: 1 }), /ask done/);
    assert.match(stepScript({ command: 'true', step: 1 }), /\nexec \/bin\/zsh -l$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a confirmed run fills the next step and names its ask [B26]', () => {
  const [signoff, ask] = readNeeds(ok(FIXTURE)).needs;
  assert.equal(askId(signoff), null);
  assert.equal(askId(ask), '3f9a0c12');
  const plan = planRun({ need: ask, n: 2, values: { device: "Ben's phone" }, root: '/r', spaces: [] });
  assert.equal(plan.command, "pullboard relay on --all --name 'Ben'\\''s phone'");
  assert.equal(plan.launch.command, 'space.new');
  assert.equal(plan.launch.args.folder, '/tmp/pullboard-needs-fixture');
  assert.match(plan.launch.args.argv[2], /cd '\/r' && pullboard ask done '3f9a0c12' --step 2 --as person/);
  assert.match(planRun({ need: { ...signoff, steps: [{ ...signoff.steps[0], cwd: '' }] }, n: 1, values: {}, spaces: [] }).refused, /no folder/);
});

/** An ask with steps 1-3 left and a board need, each running in `cwd`. */
function batchNeeds(cwd) {
  const board = { id: 'signoff:G9', source: 'board', title: 'Sign G9', next: 1, steps: [{ n: 1, label: 'Sign', cwd, command: 'echo signed {note}', prompts: [{ key: 'note', default: 'ok' }] }] };
  const ask = { id: 'ask:3f9a0c12', source: 'ask', title: 'Relay', next: 2, steps: [
    { n: 1, label: 'Done already', cwd, command: 'true', done: true },
    { n: 2, label: 'Two', cwd, command: 'echo two {device}', prompts: [{ key: 'device', default: "Ben's Mac" }] },
    { n: 3, label: 'Three', cwd, command: 'echo three' },
  ] };
  return [board, ask];
}

test('a batch runs in list order and a selected ask brings all its remaining steps [B26]', () => {
  const [board, ask] = batchNeeds('/b');
  const entries = batchEntries([board, ask], new Set([ask.id, board.id]));
  assert.deepEqual(entries.map((e) => [e.need.id, e.step.n]), [['signoff:G9', 1], ['ask:3f9a0c12', 2], ['ask:3f9a0c12', 3]]);
  assert.deepEqual(batchEntries([board, ask], new Set([ask.id])).map((e) => e.step.n), [2, 3]);
  const plan = planBatch({ entries, values: [{ note: 'x' }, {}, {}], root: '/r', spaces: [] });
  assert.deepEqual(plan.steps.map((s) => s.command), ["echo signed 'x'", "echo two 'Ben'\\''s Mac'", 'echo three']);
  assert.equal(plan.launch.command, 'space.new');
  assert.equal(plan.launch.args.tab, 'Needs you · 3 steps');
});

test('a need with no runnable step, no folder or an unsafe placeholder cannot be selected [B26]', () => {
  const [board, ask] = batchNeeds('/b');
  assert.equal(selectable(board), null);
  assert.match(selectable({ ...board, next: null }), /no step to run/);
  assert.match(selectable({ ...board, steps: [{ ...board.steps[0], cwd: '' }] }), /no folder/);
  const unsafeLater = { ...ask, steps: ask.steps.map((s) => (s.n === 3 ? { ...s, command: 'echo "{x}"', prompts: [{ key: 'x' }] } : s)) };
  assert.match(selectable(unsafeLater), /step 3: placeholder \{x\} cannot be filled safely/);
  const picked = toggleNeed(new Set(), unsafeLater);
  assert.match(picked.refused, /cannot be filled safely/);
  assert.equal(picked.selected.size, 0);
  assert.deepEqual([...toggleNeed(new Set(), board).selected], [board.id]);
  assert.deepEqual([...toggleNeed(new Set([board.id]), board).selected], []);
  assert.deepEqual(batchEntries([unsafeLater], new Set([unsafeLater.id])), []);
});

test('a batch asks each prompt in order, refuses a two-line answer, and cancel runs nothing [B26]', () => {
  const [board, ask] = batchNeeds('/b');
  const runs = [];
  const run = (command, args) => runs.push([command, args]);
  const flow = new BatchFlow([board, ask], new Set([board.id, ask.id]));
  assert.deepEqual([flow.prompt().key, flow.prompt().value, flow.prompt().k], ['note', 'ok', 1]);
  assert.match(flow.answer('a\nb'), /must be one line/);
  assert.equal(flow.answer('fine'), null);
  assert.deepEqual([flow.prompt().key, flow.prompt().value, flow.prompt().k], ['device', "Ben's Mac", 2]);
  assert.equal(flow.answer('phone'), null);
  assert.equal(flow.prompt(), null);
  assert.deepEqual(flow.review().map((s) => [s.k, s.cwd, s.command]), [[1, '/b', "echo signed 'fine'"], [2, '/b', "echo two 'phone'"], [3, '/b', 'echo three']]);
  flow.cancel();
  assert.match(flow.confirm({ root: '/r', spaces: [], run }).refused, /cancelled/);
  assert.deepEqual(runs, []);
  const early = new BatchFlow([board, ask], new Set([board.id]));
  early.cancel();
  assert.match(early.confirm({ root: '/r', spaces: [], run }).refused, /cancelled/);
  const unfinished = new BatchFlow([board], new Set([board.id]));
  assert.match(unfinished.confirm({ root: '/r', spaces: [], run }).refused, /prompt/);
  assert.deepEqual(runs, []);
  const done = new BatchFlow([ask], new Set([ask.id]));
  done.answer('mac');
  assert.equal(done.confirm({ root: '/r', spaces: [], run }).count, 2);
  assert.equal(runs.length, 1);
  assert.match(runs[0][1].argv[2], /\[1\/2\] Relay · Two/);
});

test('a batch script stops at the first failure and marks only the ask steps that passed [B26]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-batch-'));
  try {
    const log = join(dir, 'calls');
    const bin = join(dir, 'bin');
    spawnSync('/bin/mkdir', [bin, join(dir, 'work')]);
    writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\necho "$PWD $*" >> '${log}'\n`);
    chmodSync(join(bin, 'pullboard'), 0o755);
    const go = (steps) => spawnSync('/bin/zsh', ['-fc', batchScript({ steps, root: dir }).replace(/\nexec .*$/, '')],
      { encoding: 'utf8', cwd: tmpdir(), env: { PATH: `${bin}:/usr/bin:/bin` } });
    const work = join(dir, 'work');
    const step = (label, command, ask = null, n = 1) => ({ label, cwd: work, command, askId: ask, step: n });
    const out = go([step('Board', 'true'), step('One', 'pwd', 'abc', 2), step("It's two", 'false', 'abc', 3), step('Four', 'touch ran', 'abc', 4)]);
    assert.match(out.stdout, new RegExp(`\\[1/4\\] Board  \\(in ${work}\\)`));
    assert.match(out.stdout, new RegExp(`\\[2/4\\] One  \\(in ${work}\\)\\n${work}\\n`));
    assert.match(out.stdout, /stopped at \[3\/4\]: exit 1; later steps not run/);
    assert.match(out.stdout, /\[1\/4\] done: Board\n\[2\/4\] done: One\n\[3\/4\] failed: It's two\n\[4\/4\] not run: Four/);
    assert.equal(readFileSync(log, 'utf8'), `${dir} ask done abc --step 2 --as person\n`);
    assert.throws(() => readFileSync(join(work, 'ran')));
    rmSync(log);
    const all = go([step('A', 'exit 0', 'abc', 1), step('B', 'cd /', 'abc', 2)]);
    assert.match(all.stdout, /\[1\/2\] done: A\n\[2\/2\] done: B/);
    assert.equal(readFileSync(log, 'utf8'), `${dir} ask done abc --step 1 --as person\n${dir} ask done abc --step 2 --as person\n`);
    assert.match(batchScript({ steps: [step('x', 'true')], root: dir }), /\nexec \/bin\/zsh -l$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
