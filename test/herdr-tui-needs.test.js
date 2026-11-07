/**
 * The Herdr TUI "Needs you" panel's pure logic: prompt values are filled shell-quoted, only a
 * need's next step can run, and the tab script records an ask's step only after exit 0 [B26].
 * Script runs use a temporary folder and a stand-in `pullboard` on PATH.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  askId,
  batchRefusal,
  batchScript,
  batchSteps,
  configRoots,
  fillCommand,
  needsMissing,
  nextStep,
  parseNeeds,
  readBoards,
  rootPane,
  shellQuote,
  stepScript,
  stepState,
  tabCreateArgs,
} from '../integrations/herdr-tui/pullboard-needs/needs.js';
import { initialState, loaded, press, render } from '../integrations/herdr-tui/pullboard-needs/view.js';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = readFileSync(join(ROOT, 'integrations/herdr-tui/pullboard-needs/fixture.json'), 'utf8');

test('a value is single-quoted with each quote closed, escaped and reopened [B26]', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote("Ben's phone"), "'Ben'\\''s phone'");
  assert.equal(shellQuote(''), "''");
  const echoed = spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote("a'b $HOME `x` \"c\"")}`], { encoding: 'utf8' });
  assert.equal(echoed.stdout, "a'b $HOME `x` \"c\"");
});

test('only declared prompt keys are filled, each shell-quoted, defaults when unanswered [B26]', () => {
  const step = { command: 'pullboard spec signoff G9 --by BS --note {note} --who {who}', prompts: [{ key: 'note' }, { key: 'who', default: 'me' }] };
  assert.equal(fillCommand(step, { note: "it's fine; rm -rf /" }), "pullboard spec signoff G9 --by BS --note 'it'\\''s fine; rm -rf /' --who 'me'");
  assert.equal(fillCommand({ command: 'pullboard relay join {code}', prompts: [{ key: 'code' }] }, { code: 'ab-12' }), "pullboard relay join 'ab-12'");
  assert.equal(fillCommand({ command: 'pullboard relay status' }, {}), 'pullboard relay status');
});

test('a placeholder that is not a bare word among plain characters is refused, since the answer could run as shell [B26]', () => {
  const prompts = [{ key: 'note' }];
  const attack = { note: '$(touch /tmp/pwned)' };
  const refused = [
    "printf '%s' '{note}'", 'echo "said: {note}"', "echo 'a\\' \"{note}\"", 'echo "\\{note}"',
    '"$(printf "%s" "{note}")"', '"$(echo " {note} ")"', '\\{note}', '$(echo {note})', 'echo `{note}`',
    "echo \\'{note} '{other}' \"${HOME}\"",
    'cat <<EOF\n{note}\nEOF', 'cat <<-EOF\r{note}', 'cat <<< {note}', 'echo {note}\necho done',
    'echo ok # {note}', 'echo {note}#',
    'print -r -- ${(eQ):-{note}}', '--x={note}', 'echo {note} ${HOME}', "echo {note} '{x'", 'echo {note} {other}', 'echo\t{note}',
  ];
  for (const command of refused) assert.throws(() => fillCommand({ command, prompts }, attack), /cannot be filled safely/, command);
  assert.equal(fillCommand({ command: 'echo {note}', prompts }, attack), "echo '$(touch /tmp/pwned)'");
  assert.equal(fillCommand({ command: 'echo "$(date)" {other}', prompts }, attack), 'echo "$(date)" {other}');
});

test('needs JSON of another version or shape is refused, the fixture parses [B26]', () => {
  const board = parseNeeds(FIXTURE);
  assert.equal(board.needs.length, 2);
  assert.throws(() => parseNeeds('{"version":2,"needs":[]}'), /version 1/u);
  assert.throws(() => parseNeeds('{"version":1,"needs":[{"id":"x","title":"t","steps":[{"n":1}]}]}'), /without n, command or cwd/u);
  assert.deepEqual(parseNeeds('{"version":1,"root":"/r","needs":[]}'), { version: 1, root: '/r', needs: [] });
});

test('step state: done steps, the one next step, and steps waiting behind it [B26]', () => {
  const ask = parseNeeds(FIXTURE).needs[1];
  assert.deepEqual(ask.steps.map((step) => stepState(ask, step)), ['done', 'next', 'waiting']);
  assert.equal(nextStep(ask).n, 2);
  assert.equal(nextStep({ ...ask, next: null }), null);
  assert.equal(nextStep({ ...ask, next: 1 }), null);
  assert.equal(askId(ask), '3f9a0c12');
});

test('the tab is created in the given workspace and folder, and its root pane is read [B26]', () => {
  assert.deepEqual(tabCreateArgs({ workspace: 'w1', cwd: '/b', label: 'L' }), ['tab', 'create', '--workspace', 'w1', '--cwd', '/b', '--label', 'L', '--focus']);
  assert.deepEqual(tabCreateArgs({ workspace: '', cwd: '/b', label: 'L' }), ['tab', 'create', '--cwd', '/b', '--label', 'L', '--focus']);
  assert.equal(rootPane('{"result":{"tab":{},"root_pane":{"pane_id":"w1:p3"}}}'), 'w1:p3');
  assert.throws(() => rootPane('{"result":{}}'), /no root pane/u);
});

test('pullboard without the needs command is recognised from its --json refusal [B26]', () => {
  assert.equal(needsMissing('{"error":{"code":"USAGE","message":"pullboard: no command \\"needs\\"; closest match is \\"next\\"."}}'), true);
  assert.equal(needsMissing('board is busy'), false);
});

/** Run a step script with a stand-in pullboard that logs its argv and folder. */
function runScript(t, need, command) {
  const dir = mkdtempSync(join(tmpdir(), 'needs-script-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const cwd = join(dir, 'step dir');
  const root = join(dir, 'board');
  const self = join(dir, 'self');
  for (const folder of [bin, cwd, root, self]) mkdirSync(folder);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\necho "$PWD|$*" >> ${shellQuote(join(dir, 'log'))}\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const step = { ...need.steps.find((row) => row.n === need.next), cwd };
  writeFileSync(join(self, 'step.zsh'), stepScript({ need, step, command, root, self }));
  const result = spawnSync('/bin/zsh', ['-f', join(self, 'step.zsh')], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  const log = existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '';
  return { result, log, cwd, root, selfGone: !existsSync(self) };
}

test('an ask step that exits 0 is recorded done from the board root, after running in its folder [B26]', (t) => {
  const ask = parseNeeds(FIXTURE).needs[1];
  const { result, log, cwd, root, selfGone } = runScript(t, ask, `pwd > out; printf %s ${shellQuote("it's")} >> out`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[exit 0\]/u);
  assert.equal(readFileSync(join(cwd, 'out'), 'utf8'), `${cwd}\nit's`);
  assert.equal(log, `${root}|ask done 3f9a0c12 --step 2 --as person\n`);
  assert.equal(selfGone, true);
});

test('a failing ask step is not recorded, and a board need never calls ask done [B26]', (t) => {
  const ask = parseNeeds(FIXTURE).needs[1];
  const failed = runScript(t, ask, 'exit 4');
  assert.equal(failed.result.status, 4);
  assert.match(failed.result.stdout, /\[exit 4\]/u);
  assert.equal(failed.log, '');
  const falsy = runScript(t, ask, 'false');
  assert.equal(falsy.result.status, 1);
  assert.equal(falsy.log, '');
  const board = parseNeeds(FIXTURE).needs[0];
  const ran = runScript(t, board, 'true');
  assert.equal(ran.result.status, 0);
  assert.match(ran.result.stdout, /\[exit 0\]/u);
  assert.equal(ran.log, '');
});

/** Press keys in order and collect the effects. */
function keys(state, ...pressed) {
  const effects = [];
  for (const key of pressed) {
    const result = press(state, key);
    state = result.state;
    if (result.effect) effects.push(result.effect);
  }
  return { state, effects };
}

test('the popup runs only the next step, after its prompts and a confirm [B26]', () => {
  const board = parseNeeds(FIXTURE);
  const start = loaded(initialState(), board);
  const { state, effects } = keys(start, 'down', 'enter', 'enter', 'y');
  assert.equal(effects.length, 1);
  assert.equal(effects[0].run.step.n, 2);
  assert.equal(effects[0].run.command, 'pullboard relay on --all');
  assert.equal(effects[0].run.root, board.root);
  assert.equal(state.mode, 'need');

  const signed = keys(start, 'enter', 'enter', ...'it\'s ok', 'enter');
  assert.equal(signed.state.mode, 'confirm');
  assert.equal(signed.state.command, "pullboard spec signoff G9 --note 'it'\\''s ok'");
  assert.deepEqual(keys(signed.state, 'n').effects, []);

  const allDone = loaded(initialState(), { root: '/r', needs: [{ ...board.needs[1], next: null, steps: board.needs[1].steps.map((step) => ({ ...step, done: true })) }] });
  const idle = keys(allDone, 'enter', 'enter', 'y', 'enter');
  assert.deepEqual(idle.effects, []);
  assert.ok(render(idle.state, 80, 40).includes('Every step is done.   esc back   r refresh   q close'));
});

test('the popup refuses a step whose placeholder it cannot fill safely and never runs it [B26]', () => {
  const step = { n: 1, label: 'Note it', command: "printf '%s' '{note}'", cwd: '/r', prompts: [{ key: 'note', label: 'Note' }], done: false };
  const need = { id: 'ask:9c0ffee1', kind: 'ask', source: 'ask', title: 'Quoted', why: '', from: null, created: null, steps: [step], next: 1 };
  for (const command of [step.command, 'echo "{note}"']) {
    const start = loaded(initialState(), { root: '/r', needs: [{ ...need, steps: [{ ...step, command }] }] });
    const { state, effects } = keys(start, 'enter', 'enter', ...'$(id)', 'enter', 'y', 'enter');
    assert.deepEqual(effects, [], command);
    assert.equal(state.mode, 'note', command);
    assert.match(state.note, /cannot be filled safely/);
    assert.ok(render(state, 80, 40).some((line) => line.includes('cannot run safely')), command);
  }
});

test('an answer with a line break or NUL is refused before filling, and the popup shows why [B26]', () => {
  const step = { command: 'echo ok {note}', prompts: [{ key: 'note' }] };
  for (const note of ['\ntouch /tmp/x\n#', 'a\rb', 'a\0b']) {
    assert.throws(() => fillCommand(step, { note }), /answer for \{note\} must be one line/u, JSON.stringify(note));
  }
  assert.throws(() => fillCommand({ command: 'echo {note}', prompts: [{ key: 'note', default: 'a\nb' }] }), /must be one line/u);
  const shown = { n: 1, label: 'Note it', cwd: '/r', ...step, done: false };
  const need = { id: 'ask:9c0ffee1', kind: 'ask', source: 'ask', title: 'Multiline', why: '', from: null, created: null, steps: [shown], next: 1 };
  const start = loaded(initialState(), { root: '/r', needs: [need] });
  const { state, effects } = keys(start, 'enter', 'enter', ...'a\ntouch /tmp/x', 'enter', 'y', 'enter');
  assert.deepEqual(effects, []);
  assert.equal(state.mode, 'note');
  assert.match(state.note, /must be one line/u);
  assert.ok(render(state, 80, 40).some((line) => line.includes('cannot run safely')));
});

test('the step view marks done, next and waiting steps; a note replaces the list [B26]', () => {
  const opened = keys(loaded(initialState(), parseNeeds(FIXTURE)), 'down', 'enter').state;
  const lines = render(opened, 80, 40);
  assert.ok(lines.includes('[x] 1. Check the relay'));
  assert.ok(lines.includes('[>] 2. Turn the relay on  (your terminal)'));
  assert.ok(lines.includes('[ ] 3. Pair the phone  (your terminal)'));
  const note = loaded(initialState(), { note: 'This pullboard has no `needs` command yet.' });
  assert.deepEqual(render(note, 80, 10), ['Needs you', '', 'This pullboard has no `needs` command yet.', '', 'r refresh   q close']);
  assert.ok(render(opened, 10, 3).every((line) => line.length <= 10));
});

test('a batch takes the selected needs in list order, with every remaining step of an ask [B26]', () => {
  const board = parseNeeds(FIXTURE);
  const picked = batchSteps(board.needs, ['ask:3f9a0c12', 'signoff:G9']);
  assert.deepEqual(picked.map(({ need, step }) => `${need.id}#${step.n}`), ['signoff:G9#1', 'ask:3f9a0c12#2', 'ask:3f9a0c12#3']);

  const start = loaded(initialState(), board);
  const chosen = keys(start, ' ', 'down', ' ');
  assert.deepEqual(chosen.state.selected, [`${board.root}\nsignoff:G9`, `${board.root}\nask:3f9a0c12`]);
  assert.ok(render(chosen.state, 80, 40).some((line) => line.startsWith('> [x] Link the board to the relay')));
  const asked = keys(chosen.state, 'r', ...'ok', 'enter');
  assert.equal(asked.state.mode, 'prompt');
  assert.ok(render(asked.state, 80, 40).some((line) => line.includes('[3/3]')));
  const ready = keys(asked.state, 'enter');
  assert.equal(ready.state.mode, 'batch');
  const screen = render(ready.state, 120, 40);
  assert.ok(screen.includes("  1. pullboard spec signoff G9 --note 'ok'"));
  assert.ok(screen.includes('  2. pullboard relay on --all'));
  assert.ok(screen.includes("  3. pullboard relay pair --name 'Ben'\\''s phone'"));
  assert.ok(screen.includes('     in /tmp/pullboard-needs-fixture'));
  const ran = keys(ready.state, 'y');
  assert.equal(ran.effects.length, 1);
  assert.deepEqual(ran.effects[0].batch.items.map(({ need, step, command }) => [need.id, step.n, command]), [
    ['signoff:G9', 1, "pullboard spec signoff G9 --note 'ok'"],
    ['ask:3f9a0c12', 2, 'pullboard relay on --all'],
    ['ask:3f9a0c12', 3, "pullboard relay pair --name 'Ben'\\''s phone'"],
  ]);
  assert.equal(ran.effects[0].batch.root, board.root);
  assert.equal(keys(chosen.state, 'enter', 'escape').state.mode, 'list');
  assert.equal(keys(chosen.state, 'enter').state.mode, 'prompt');
});

test('a need without a safe next step cannot be selected, and the list says why [B26]', () => {
  const step = { n: 1, label: 'Note it', command: "printf '%s' '{note}'", cwd: '/r', prompts: [{ key: 'note' }], done: false };
  const unsafe = { id: 'ask:9c0ffee1', kind: 'ask', source: 'ask', title: 'Quoted', steps: [{ ...step, n: 1, command: 'true' }, { ...step, n: 2 }], next: 1 };
  const finished = { id: 'signoff:G1', kind: 'signoff', source: 'board', title: 'Finished', steps: [{ ...step, command: 'true', done: true }], next: null };
  assert.match(batchRefusal(unsafe), /cannot be filled safely/u);
  assert.match(batchRefusal(finished), /no step to run/u);
  assert.equal(batchRefusal(parseNeeds(FIXTURE).needs[1]), '');
  const start = loaded(initialState(), { root: '/r', needs: [unsafe, finished] });
  const pressed = keys(start, ' ', 'down', ' ', 'r');
  assert.deepEqual(pressed.state.selected, []);
  assert.deepEqual(pressed.effects, ['refresh']);
  const lines = render(keys(start, ' ').state, 120, 40);
  assert.ok(lines.includes('> [-] Quoted  [ask] 0/2'));
  assert.ok(lines.some((line) => line.startsWith('Cannot select: ') && line.includes('cannot be filled safely')));
  assert.deepEqual(batchSteps([unsafe, finished], ['ask:9c0ffee1', 'signoff:G1']), []);
});

test('cancelling a batch at a prompt or at the confirm runs nothing [B26]', () => {
  const start = loaded(initialState(), parseNeeds(FIXTURE));
  const chosen = keys(start, ' ', 'down', ' ').state;
  for (const cancel of [['r', 'escape'], ['r', 'enter', 'escape'], ['r', 'enter', 'enter', 'n'], ['r', 'enter', 'enter', 'escape']]) {
    const { state, effects } = keys(chosen, ...cancel);
    assert.deepEqual(effects, [], cancel.join(' '));
    assert.equal(state.mode, 'list', cancel.join(' '));
    assert.equal(state.batch, null, cancel.join(' '));
  }
  const multiline = keys(chosen, 'r', ...'a\nb', 'enter', 'enter', 'y');
  assert.deepEqual(multiline.effects, []);
  assert.equal(multiline.state.mode, 'note');
});

/** Run a batch script in a temporary folder with a stand-in pullboard that logs its argv and folder. */
function runBatch(t, items) {
  const dir = mkdtempSync(join(tmpdir(), 'needs-batch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const root = join(dir, 'board');
  const self = join(dir, 'self');
  for (const folder of [bin, root, self, join(dir, 'a dir'), join(dir, 'b')]) mkdirSync(folder);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\necho "$PWD|$*" >> ${shellQuote(join(dir, 'log'))}\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const filled = items.map(({ need, step, command }) => ({ need, step: { ...step, cwd: join(dir, step.cwd) }, command }));
  writeFileSync(join(self, 'batch.zsh'), batchScript({ items: filled, root, self }));
  const result = spawnSync('/bin/zsh', ['-f', join(self, 'batch.zsh')], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  const log = existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '';
  return { result, log, dir, root, selfGone: !existsSync(self) };
}

test('a batch script runs steps in order, stops at the first failure and marks only passed ask steps done [B26]', (t) => {
  const ask = { id: 'ask:3f9a0c12', source: 'ask', title: 'Ask' };
  const board = { id: 'signoff:G9', source: 'board', title: 'Board' };
  const step = (n, label, cwd) => ({ n, label, cwd, command: 'unused' });
  const items = [
    { need: board, step: step(1, 'Board one', 'b'), command: 'touch ran1' },
    { need: ask, step: step(2, "Ask's two", 'a dir'), command: 'pwd > ran2' },
    { need: ask, step: step(3, 'Ask three', 'b'), command: 'false' },
    { need: ask, step: step(4, 'Ask four', 'b'), command: 'touch ran4' },
  ];
  const { result, log, dir, root, selfGone } = runBatch(t, items);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(selfGone, true);
  assert.equal(existsSync(join(dir, 'b', 'ran1')), true);
  assert.equal(readFileSync(join(dir, 'a dir', 'ran2'), 'utf8'), `${join(dir, 'a dir')}\n`);
  assert.equal(existsSync(join(dir, 'b', 'ran4')), false);
  assert.equal(log, `${root}|ask done 3f9a0c12 --step 2 --as person\n`);
  const out = result.stdout;
  assert.ok(out.includes(`[1/4] Board one  (in ${join(dir, 'b')})`), out);
  assert.ok(out.includes(`[2/4] Ask's two  (in ${join(dir, 'a dir')})`), out);
  assert.ok(out.includes('stopped at [3/4]: exit 1; later steps not run'), out);
  assert.ok(!out.includes('[4/4] Ask four  (in'), out);
  assert.match(out, /\[1\/4\] Board one: done\n\[2\/4\] Ask's two: done\n\[3\/4\] Ask three: failed \(exit 1\)\n\[4\/4\] Ask four: not run\n/u);

  const passed = runBatch(t, items.filter((item) => item.step.n !== 3));
  assert.equal(passed.result.status, 0, passed.result.stderr);
  assert.equal(passed.log, `${passed.root}|ask done 3f9a0c12 --step 2 --as person\n${passed.root}|ask done 3f9a0c12 --step 4 --as person\n`);
  assert.match(passed.result.stdout, /\[3\/3\] Ask four: done\n/u);
});

/** Join a command's wrapped lines back into one string: each line after its fixed-width prefix. */
function unwrap(lines, first, rest) {
  const at = lines.findIndex((line) => line.startsWith(first));
  const parts = [lines[at].slice(first.length)];
  for (let next = at + 1; lines[next]?.startsWith(rest) && !lines[next].slice(rest.length).startsWith('in '); next += 1) parts.push(lines[next].slice(rest.length));
  return parts.join('');
}

test('a confirm screen wraps a long command and folder in full instead of cutting them off [B26]', () => {
  const cwd = `/tmp/${'deep/'.repeat(12)}folder-end`;
  const command = `pullboard relay pair --name {device} ${'--flag-x '.repeat(8)}--last-flag`;
  const step = { n: 1, label: 'Long', command, cwd, prompts: [{ key: 'device', default: 'phone' }], done: false };
  const need = { id: 'ask:0123abcd', kind: 'ask', source: 'ask', title: 'Long', steps: [step], next: 1 };
  const filled = command.replace('{device}', "'phone'");
  const start = loaded(initialState(), { root: '/r', needs: [need] });

  const single = keys(start, 'enter', 'enter', 'enter').state;
  assert.equal(single.mode, 'confirm');
  const one = render(single, 40, 60);
  assert.ok(one.every((line) => line.length <= 40));
  assert.equal(unwrap(one, '  ', '    '), filled);
  assert.equal(unwrap(one, '  in ', '     '), cwd);

  const batch = keys(start, ' ', 'r', 'enter').state;
  assert.equal(batch.mode, 'batch');
  const all = render(batch, 40, 60);
  assert.ok(all.every((line) => line.length <= 40));
  assert.equal(unwrap(all, '  1. ', '     '), filled);
  assert.equal(unwrap(all, '     in ', '        '), cwd);
  const short = render(batch, 40, 6);
  assert.equal(short.length, 6);
  const scrolled = [];
  for (let down = 0; down < 30; down += 1) scrolled.push(...render(keys(batch, ...Array(down).fill('down')).state, 40, 6).slice(0, 5));
  assert.ok(scrolled.some((line) => line.endsWith('--last-flag')));
  assert.ok(scrolled.some((line) => line.endsWith('folder-end')));
});

test('a single step confirm on a short screen scrolls to the end of a long command and folder, footer kept [B26]', () => {
  const cwd = `/tmp/${'deep/'.repeat(12)}folder-end`;
  const command = `pullboard relay pair ${'--flag-x '.repeat(8)}--last-flag`;
  const need = { id: 'ask:0123abcd', kind: 'ask', source: 'ask', title: 'Long', steps: [{ n: 1, label: 'Long', command, cwd, prompts: [], done: false }], next: 1 };
  const confirm = keys(loaded(initialState(), { root: '/r', needs: [need] }), 'enter', 'enter').state;
  assert.equal(confirm.mode, 'confirm');
  const seen = [];
  for (let down = 0; down < 30; down += 1) {
    const screen = render(keys(confirm, ...Array(down).fill('down')).state, 40, 6);
    assert.equal(screen.length, 6);
    assert.equal(screen[5], 'up/down scroll   y run   n cancel', `after ${down} down`);
    seen.push(...screen.slice(0, 5));
  }
  const tall = render(confirm, 40, 100);
  assert.equal(unwrap(tall, '  ', '    '), command);
  assert.equal(unwrap(tall, '  in ', '     '), cwd);
  for (const line of tall.slice(0, -1)) assert.ok(seen.includes(line), line);
  const back = keys(confirm, ...Array(30).fill('down'), ...Array(30).fill('up')).state;
  assert.deepEqual(render(back, 40, 6), render(confirm, 40, 6));
  assert.equal(keys(confirm, 'down', 'down', 'y').effects[0].run.command, command);
  assert.equal(render(confirm, 80, 40).at(-1), 'y run   n cancel');
});

/** Terminal cells a test line takes: the wide test character 界 takes two, everything else here one. */
function cellsOf(line) {
  return [...line].reduce((sum, char) => sum + (char === '界' ? 2 : 1), 0);
}

test('confirm screens wrap wide characters by terminal cells, so nothing spills past the width [B26]', () => {
  const command = `echo '${'界'.repeat(200)}'`;
  const need = { id: 'ask:0123abcd', kind: 'ask', source: 'ask', title: 'Wide', steps: [{ n: 1, label: 'Wide', command, cwd: '/r', prompts: [], done: false }], next: 1 };
  const start = loaded(initialState(), { root: '/r', needs: [need] });
  for (const [confirm, first, rest] of [[keys(start, 'enter', 'enter').state, '  ', '    '], [keys(start, ' ', 'r').state, '  1. ', '     ']]) {
    assert.ok(['confirm', 'batch'].includes(confirm.mode));
    const top = render(confirm, 40, 6);
    assert.ok(top.some((line) => line.startsWith(`${first}echo '界`)), top.join('\n'));
    const seen = [];
    for (let down = 0; down < 40; down += 1) {
      const screen = render(keys(confirm, ...Array(down).fill('down')).state, 40, 6);
      for (const line of screen) assert.ok(cellsOf(line) <= 40, line);
      seen.push(...screen.slice(0, 5));
    }
    const tall = render(confirm, 40, 200);
    assert.equal(unwrap(tall, first, rest), command);
    for (const line of tall.slice(0, -1)) assert.ok(seen.includes(line), line);
  }
});

test('an answer with a control character is refused, and a control character in a step shows as text [B26]', () => {
  assert.throws(() => fillCommand({ command: 'echo {note}', prompts: [{ key: 'note' }] }, { note: 'a\x1b[2Jb' }), /control character/u);
  for (const note of ['a\x07b', 'a\x7fb', 'a\x9bb', 'a\tb']) {
    assert.throws(() => fillCommand({ command: 'echo {note}', prompts: [{ key: 'note' }] }, { note }), /control character/u, JSON.stringify(note));
  }
  const command = 'printf \x1b[2J\x1b]0;x\x07';
  const need = { id: 'ask:0123abcd', kind: 'ask', source: 'ask', title: 'Esc', steps: [{ n: 1, label: 'Esc', command, cwd: '/r\x1bq', prompts: [], done: false }], next: 1 };
  const start = loaded(initialState(), { root: '/r', needs: [need] });
  for (const confirm of [keys(start, 'enter', 'enter').state, keys(start, ' ', 'r').state]) {
    const drawn = render(confirm, 80, 40);
    assert.ok(drawn.every((line) => !/[\x00-\x1f\x7f-\x9f]/u.test(line.replaceAll('\x1b[7m', '').replaceAll('\x1b[27m', ''))), drawn.join('|'));
    const lines = drawn.map(seenText);
    assert.ok(lines.some((line) => line.includes('printf \\x1b[2J\\x1b]0;x\\x07')), lines.join('\n'));
    assert.ok(lines.some((line) => line.includes('in /r\\x1bq')), lines.join('\n'));
    assert.ok(drawn.some((line) => decodeEscapes(line).includes(command)), drawn.join('\n'));
  }
  assert.equal(keys(start, 'enter', 'enter', 'y').effects[0].run.command, command);
  assert.ok(render(keys(start, 'enter').state, 80, 40).every((line) => !/[\x00-\x1f\x7f-\x9f]/u.test(line.replaceAll('\x1b[7m', '').replaceAll('\x1b[27m', ''))));
});

/** The most cells a code point can take: printable ASCII one, zero-width marks none, anything else two. */
function widest(line) {
  return [...line].reduce((sum, char) => sum + (/^[\x20-\x7e]$/u.test(char) ? 1 : /[\p{Mn}\p{Me}\p{Cf}]/u.test(char) ? 0 : 2), 0);
}

test('confirm screens count every non-ASCII character as two cells, so no emoji or symbol overflows [B26]', () => {
  const mixes = ['❤️'.repeat(200), `${'é é Ω — 👩‍👩‍👧 '.repeat(20)}end`];
  for (const text of mixes) {
    const command = `echo '${text}'`;
    const need = { id: 'ask:0123abcd', kind: 'ask', source: 'ask', title: 'Wide', steps: [{ n: 1, label: 'Wide', command, cwd: `/r/${text.slice(0, 30)}`, prompts: [], done: false }], next: 1 };
    const start = loaded(initialState(), { root: '/r', needs: [need] });
    for (const [confirm, first, rest] of [[keys(start, 'enter', 'enter').state, '  ', '    '], [keys(start, ' ', 'r').state, '  1. ', '     ']]) {
      const top = render(confirm, 40, 6);
      assert.ok(top.some((line) => line.startsWith(`${first}echo '`)), top.join('\n'));
      const seen = [];
      for (let down = 0; down < 80; down += 1) {
        const screen = render(keys(confirm, ...Array(down).fill('down')).state, 40, 6);
        for (const line of screen.map(seenText)) assert.ok(widest(line) <= 40, `${widest(line)}: ${line}`);
        seen.push(...screen.slice(0, 5));
      }
      const tall = render(confirm, 40, 400);
      assert.equal(unwrap(tall.map(decodeEscapes), first, rest), command);
      for (const line of tall.slice(0, -1)) assert.ok(seen.includes(line), line);
    }
  }
});

/** Cells a line takes at most: a grapheme with any non-ASCII part draws in two cells, else one. */
function graphemeCells(line) {
  let sum = 0;
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(line)) sum += /[^\x20-\x7e]/u.test(segment) ? 2 : 1;
  return sum;
}

test('confirm screens keep keycaps and combining accents inside the width, whole [B26]', () => {
  for (const text of ['1️⃣'.repeat(200), 'é'.repeat(200)]) {
    const command = `echo '${text}'`;
    const need = { id: 'ask:0123abcd', kind: 'ask', source: 'ask', title: 'Keycap', steps: [{ n: 1, label: 'Keycap', command, cwd: '/r', prompts: [], done: false }], next: 1 };
    const start = loaded(initialState(), { root: '/r', needs: [need] });
    for (const [confirm, first, rest] of [[keys(start, 'enter', 'enter').state, '  ', '    '], [keys(start, ' ', 'r').state, '  1. ', '     ']]) {
      assert.ok(render(confirm, 40, 6).some((line) => line.startsWith(`${first}echo '`)));
      const seen = [];
      for (let down = 0; down < 120; down += 1) {
        const screen = render(keys(confirm, ...Array(down).fill('down')).state, 40, 6);
        for (const line of screen.map(seenText)) assert.ok(graphemeCells(line) <= 40, `${graphemeCells(line)}: ${line}`);
        seen.push(...screen.slice(0, 5));
      }
      const tall = render(confirm, 40, 600);
      assert.equal(unwrap(tall.map(decodeEscapes), first, rest), command);
      for (const line of tall.slice(0, -1)) assert.ok(seen.includes(line), line);
      const body = tall.filter((line) => line.startsWith(rest) || line.startsWith(first));
      assert.ok(body.every((line) => !/^\s*[️⃣́]/u.test(line.slice(rest.length))), 'a line starts mid-grapheme');
    }
  }
});

/** The text a styled panel escape stands for: \xNN or \u{hex} back to its code point. */
function decodeEscapes(line) {
  return line.replace(/\x1b\[7m\\(?:x([0-9a-f]{2})|u\{([0-9a-f]+)\})\x1b\[27m/gu, (_, byte, point) => String.fromCodePoint(parseInt(byte ?? point, 16)));
}

/** A line as a person sees it: each styled escape is its visible ASCII text. */
function seenText(line) {
  return line.replace(/\x1b\[7m(\\(?:x[0-9a-f]{2}|u\{[0-9a-f]+\}))\x1b\[27m/gu, '$1');
}

/** Cells a line takes at most once styled escapes are their text: any non-ASCII grapheme two, else one. */
function fuzzCells(line) {
  let sum = 0;
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(seenText(line))) sum += /[^\x20-\x7e]/u.test(segment) ? 2 : 1;
  return sum;
}

/** Rebuild the command, then the folder, from the lines after the command's first line. */
function rebuild(lines, at, parts) {
  let index = at;
  for (const { text, first, rest } of parts) {
    let acc = '';
    for (let line = 0; acc !== text; line += 1, index += 1) {
      assert.ok(index < lines.length, `ran out of lines rebuilding ${JSON.stringify(text)} from ${JSON.stringify(acc)}`);
      const prefix = line ? rest : first;
      assert.ok(lines[index].startsWith(prefix), JSON.stringify(lines[index]));
      acc += decodeEscapes(lines[index].slice(prefix.length));
      assert.ok(text.startsWith(acc), `${JSON.stringify(acc)} is not the start of ${JSON.stringify(text)}`);
    }
  }
}

/** Every line within the width at every scroll position, footer kept, and the command and folder rebuilt whole. */
function checkConfirm(confirm, { command, cwd, cols, rows, first, rest, cwdFirst, cwdRest, at }) {
  const tall = render(confirm, cols, 10000);
  assert.ok(tall[at].startsWith(first), `${at}: ${JSON.stringify(tall)}`);
  rebuild(tall, at, [{ text: command, first, rest }, { text: cwd, first: cwdFirst, rest: cwdRest }]);
  const footer = tall.at(-1);
  const top = render(confirm, cols, rows);
  if (at < rows - 1) assert.equal(top[at], tall[at]);
  const seen = [];
  for (let scroll = 0; scroll <= tall.length; scroll += 1) {
    const screen = render({ ...confirm, scroll }, cols, rows);
    assert.ok(screen.length <= rows);
    for (const line of screen) assert.ok(fuzzCells(line) <= cols, `${fuzzCells(line)} > ${cols}: ${JSON.stringify(line)}`);
    assert.ok(screen.at(-1).endsWith(footer), JSON.stringify(screen.at(-1)));
    seen.push(...screen.slice(0, -1));
  }
  for (const line of tall.slice(0, -1)) assert.ok(seen.includes(line), JSON.stringify(line));
}

test('an answer of stacked combining accents is shown whole on both confirm screens [B26]', () => {
  const answer = `e${'́'.repeat(20)}`;
  const step = { n: 1, label: 'Accent', command: 'echo {answer}', cwd: '/r', prompts: [{ key: 'answer' }], done: false };
  const need = { id: 'ask:0123abcd', kind: 'ask', source: 'ask', title: 'Accent', steps: [step], next: 1 };
  const start = loaded(initialState(), { root: '/r', needs: [need] });
  const command = `echo '${answer}'`;
  const single = keys(start, 'enter', 'enter', ...answer, 'enter');
  assert.equal(single.state.mode, 'confirm');
  checkConfirm(single.state, { command, cwd: '/r', cols: 40, rows: 6, first: '  ', rest: '    ', cwdFirst: '  in ', cwdRest: '     ', at: 4 });
  assert.equal(keys(single.state, 'y').effects[0].run.command, command);
  const batch = keys(start, ' ', 'r', ...answer, 'enter');
  assert.equal(batch.state.mode, 'batch');
  checkConfirm(batch.state, { command, cwd: '/r', cols: 40, rows: 6, first: '  1. ', rest: '     ', cwdFirst: '     in ', cwdRest: '        ', at: 2 });
  assert.equal(keys(batch.state, 'y').effects[0].batch.items[0].command, command);
});

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fuzzed commands and folders are shown whole, within the width, at every scroll on both confirm screens [B26]', () => {
  const random = mulberry32(0xb26);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const pool = [
    () => pick([...'abcXYZ ']), () => '界', () => '❤️', () => '1️⃣', () => '👩‍👩‍👧', () => 'é', () => 'é',
    () => '́'.repeat(1 + Math.floor(random() * 60)), () => '​', () => '️', () => '\x1b', () => '\x7f',
    () => '\\x1b', () => '\\u{301}',
  ];
  const text = (most) => Array.from({ length: Math.floor(random() * most) }, () => pick(pool)()).join('');
  for (let run = 0; run < 500; run += 1) {
    const command = `echo ${text(40)}`;
    const cwd = `/${text(12)}`;
    const cols = 20 + Math.floor(random() * 61);
    const rows = 4 + Math.floor(random() * 7);
    const need = { id: 'ask:0123abcd', kind: 'ask', source: 'ask', title: text(10), steps: [{ n: 1, label: 'Fuzz', command, cwd, prompts: [], done: false }], next: 1 };
    const start = loaded(initialState(), { root: '/r', needs: [need] });
    const label = `run ${run}`;
    try {
      checkConfirm(keys(start, 'enter', 'enter').state, { command, cwd, cols, rows, first: '  ', rest: '    ', cwdFirst: '  in ', cwdRest: '     ', at: 4 });
      checkConfirm(keys(start, ' ', 'r').state, { command, cwd, cols, rows, first: '  1. ', rest: '     ', cwdFirst: '     in ', cwdRest: '        ', at: 2 });
    } catch (error) {
      error.message = `${label} ${JSON.stringify({ command, cwd, cols, rows })}: ${error.message}`;
      throw error;
    }
  }
});

test('the panel reads every configured board, the old single root still works [B26]', async () => {
  assert.deepEqual(configRoots({ root: '/a' }), ['/a'], 'an install from before several boards keeps its board');
  assert.deepEqual(configRoots({ roots: ['/a', '/b', '/a'] }), ['/a', '/b']);
  assert.deepEqual(configRoots({ roots: [], root: '/a' }), ['/a']);
  assert.deepEqual(configRoots({}), []);
  assert.deepEqual(configRoots(null), []);
  const read = await readBoards(['/x/superagent', '/x/session-handoff-kit', '/x/broken'], async (root) => {
    if (root.endsWith('broken')) return { note: `Could not read what needs you in ${root}: boom` };
    return { root, needs: [{ id: 'draft:G1', title: `Approve G1 in ${root}`, steps: [], next: null }] };
  });
  assert.deepEqual(read.boards.map((board) => [board.name, board.root, board.note ?? board.needs.length]), [
    ['superagent', '/x/superagent', 1],
    ['session-handoff-kit', '/x/session-handoff-kit', 1],
    ['broken', '/x/broken', 'Could not read what needs you in /x/broken: boom'],
  ], 'a board that fails keeps its place and its note, and hides no other board');
});

test('needs from several boards list under a heading each, and every run and batch keeps its board [B26]', (t) => {
  const step = (cwd, command) => ({ n: 1, label: 'Go', command, cwd, prompts: [], personOnly: true, done: false });
  const ask = (root) => ({ id: 'ask:3f9a0c12', kind: 'ask', source: 'ask', title: `Ask in ${root}`, steps: [step(root, 'true')], next: 1 });
  const draft = (root) => ({ id: 'draft:G1', kind: 'draft', source: 'board', title: 'Approve G1: same id on both boards', steps: [step(root, 'pullboard spec approve G1')], next: 1 });
  const start = loaded(initialState(), { boards: [
    { root: '/x/superagent', name: 'superagent', needs: [draft('/x/superagent')] },
    { root: '/x/broken', name: 'broken', note: 'Could not read what needs you in /x/broken: boom' },
    { root: '/x/session-handoff-kit', name: 'session-handoff-kit', needs: [draft('/x/session-handoff-kit'), ask('/x/session-handoff-kit')] },
  ] });
  assert.equal(start.mode, 'list');
  const screen = render(start, 100, 40);
  const at = (text) => screen.findIndex((line) => line.includes(text));
  assert.ok(at('superagent') >= 0 && at('broken') > at('superagent') && at('session-handoff-kit') > at('broken'), screen.join('\n'));
  assert.ok(at('boom') > at('broken') && at('boom') < at('session-handoff-kit'), 'a failed board shows its note under its heading');
  assert.equal(screen.filter((line) => line.includes('Approve G1')).length, 2, 'the same id on two boards is two needs');

  const single = keys(start, 'down', 'enter', 'enter', 'y');
  assert.equal(single.effects[0].run.root, '/x/session-handoff-kit', 'a run carries its own board');

  const chosen = keys(start, ' ', 'down', ' ', 'down', ' ');
  assert.equal(chosen.state.selected.length, 3, 'the same id on two boards is selected separately');
  const ran = keys(chosen.state, 'r', 'y');
  assert.deepEqual(ran.effects[0].batch.items.map(({ need, command }) => [need.root, command]), [
    ['/x/superagent', 'pullboard spec approve G1'],
    ['/x/session-handoff-kit', 'pullboard spec approve G1'],
    ['/x/session-handoff-kit', 'true'],
  ], 'one batch mixes boards, each step keeping its own');

  const dir = mkdtempSync(join(tmpdir(), 'needs-boards-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [one, two] = [join(dir, 'one'), join(dir, 'two')];
  const bin = join(dir, 'bin');
  const self = join(dir, 'self');
  for (const folder of [one, two, bin, self]) mkdirSync(folder);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\necho "$PWD|$*" >> ${shellQuote(join(dir, 'log'))}\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const items = [one, two].map((root) => ({ need: { ...ask(root), root }, step: step(root, 'true'), command: 'true' }));
  writeFileSync(join(self, 'batch.zsh'), batchScript({ items, root: one, self }));
  const result = spawnSync('/bin/zsh', ['-f', join(self, 'batch.zsh')], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, 'log'), 'utf8'), `${one}|ask done 3f9a0c12 --step 1 --as person\n${two}|ask done 3f9a0c12 --step 1 --as person\n`,
    'each ask is marked done on its own board');
});

test('several boards with no need to run still show each note and draw without a cursor [B26]', () => {
  const state = loaded(initialState(), { boards: [
    { root: '/x/broken', name: 'broken', note: 'Could not read what needs you in /x/broken: boom' },
    { root: '/x/quiet', name: 'quiet', needs: [] },
  ] });
  const screen = render(state, 80, 20);
  assert.ok(screen.some((line) => line.includes('boom')), screen.join('\n'));
  assert.ok(screen.some((line) => line.includes('Nothing needs you here.')), screen.join('\n'));
  assert.deepEqual(keys(state, 'down', ' ', 'enter').effects, [], 'no key acts on a need that is not there');
});
