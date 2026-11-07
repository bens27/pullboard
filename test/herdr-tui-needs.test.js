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
import { askId, fillCommand, needsMissing, nextStep, parseNeeds, rootPane, shellQuote, stepScript, stepState, tabCreateArgs } from '../integrations/herdr-tui/pullboard-needs/needs.js';
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
  const step = { command: 'pullboard spec signoff G9 --note {note} --who {who} ${HOME} {other}', prompts: [{ key: 'note' }, { key: 'who', default: 'me' }] };
  assert.equal(fillCommand(step, { note: "it's fine; rm -rf /" }), "pullboard spec signoff G9 --note 'it'\\''s fine; rm -rf /' --who 'me' ${HOME} {other}");
  assert.equal(fillCommand({ command: 'pullboard relay status' }, {}), 'pullboard relay status');
});

test('a declared placeholder near a quote, backslash or $( is refused, since the answer could run as shell [B26]', () => {
  const prompts = [{ key: 'note' }];
  const attack = { note: '$(touch /tmp/pwned)' };
  const refused = [
    "printf '%s' '{note}'", 'echo "said: {note}"', "echo 'a\\' \"{note}\"", 'echo "\\{note}"',
    '"$(printf "%s" "{note}")"', '"$(echo " {note} ")"', '\\{note}', '$(echo {note})', 'echo `{note}`',
    "echo \\'{note} '{other}' \"${HOME}\"",
    'cat <<EOF\n{note}\nEOF', 'cat <<-EOF\r{note}', 'cat <<< {note}', 'echo {note}\necho done',
    'echo ok # {note}', 'echo {note}#',
  ];
  for (const command of refused) assert.throws(() => fillCommand({ command, prompts }, attack), /cannot be filled safely/, command);
  assert.equal(fillCommand({ command: "echo {note} ${HOME} '{x'", prompts }, attack), "echo '$(touch /tmp/pwned)' ${HOME} '{x'");
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
