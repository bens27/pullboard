/**
 * The "Needs you" popup as pure state: a key press moves the state and may ask the panel for an
 * effect (quit, refresh, run a step or run a batch), and render draws a state as lines [B26]. Keeping the screen
 * logic free of the terminal lets tests prove that only a need's next step can ever run.
 */
import {
  batchRefusal,
  batchSteps,
  fillCommand,
  nextStep,
  stepState,
} from './needs.js';

/** @returns {any} */
export function initialState() {
  return { mode: 'loading', needs: [], boards: [], root: '', cursor: 0, need: null, step: null, promptIndex: 0, values: {}, input: '', command: '', note: '', selected: [], batch: null, scroll: 0 };
}

// Each need carries its board's root, where its asks are marked done, and a key naming board and
// id together, since two boards can list the same id and selecting one must not select both.
function tagged(root, needs) {
  return needs.map((need) => ({ ...need, root, key: `${root}\n${need.id}` }));
}

/**
 * The state after the boards were read, keeping the cursor on the same need when it is still there.
 * Takes every board at once, or the one board or note an older reader returns.
 *
 * @param {any} state
 * @param {{ boards: any[] } | { needs: any[], root: string } | { note: string }} read
 * @returns {any}
 */
export function loaded(state, read) {
  if ('note' in read) return { ...state, mode: 'note', needs: [], boards: [], note: read.note };
  const boards = read.boards ?? [];
  if (boards.length === 1 && 'note' in boards[0]) return { ...state, mode: 'note', needs: [], boards: [], note: boards[0].note };
  const needs = read.boards ? boards.flatMap((board) => tagged(board.root, board.needs ?? [])) : tagged(read.root, read.needs);
  const key = state.needs[state.cursor]?.key;
  const kept = needs.findIndex((need) => need.key === key);
  // A need that left the board or can no longer run safely drops out of the selection.
  const selected = state.selected.filter((sel) => needs.some((need) => need.key === sel && !batchRefusal(need)));
  const root = read.root ?? boards[0]?.root ?? '';
  return { ...state, mode: 'list', needs, boards, root, cursor: Math.max(0, kept), need: null, step: null, selected, batch: null };
}

function beginStep(state) {
  const step = nextStep(state.need);
  if (!step) return { state };
  const prompts = step.prompts ?? [];
  const begun = { ...state, step, values: {}, promptIndex: 0 };
  const refused = refusal(step, {});
  if (refused) return { state: refused(begun) };
  if (!prompts.length) return { state: confirm(begun) };
  return { state: { ...begun, mode: 'prompt', input: prompts[0].default ?? '' } };
}

// A template fillCommand refuses (an unsafe placeholder) becomes a note and never runs,
// checked before the prompts so the person does not answer them in vain.
function refusal(step, values) {
  try { fillCommand(step, values); return null; }
  catch (error) { return (state) => ({ ...state, mode: 'note', step: null, command: '', note: `This step cannot run safely: ${error.message}` }); }
}

function confirm(state) {
  const refused = refusal(state.step, state.values);
  if (refused) return refused(state);
  return { ...state, mode: 'confirm', command: fillCommand(state.step, state.values), scroll: 0 };
}

function promptKey(state, key) {
  if (state.batch) return batchPromptKey(state, key);
  const prompts = state.step.prompts;
  if (key === 'escape') return { state: { ...state, mode: 'need', step: null } };
  if (key === 'enter') {
    const values = { ...state.values, [prompts[state.promptIndex].key]: state.input };
    const promptIndex = state.promptIndex + 1;
    if (promptIndex >= prompts.length) return { state: confirm({ ...state, values }) };
    return { state: { ...state, values, promptIndex, input: prompts[promptIndex].default ?? '' } };
  }
  return editKey(state, key);
}

function editKey(state, key) {
  if (key === 'backspace') return { state: { ...state, input: [...state.input].slice(0, -1).join('') } };
  if (key === 'ctrl+u') return { state: { ...state, input: '' } };
  if ([...key].length === 1) return { state: { ...state, input: state.input + key } };
  return { state };
}

function toggle(state) {
  const need = state.needs[state.cursor];
  if (batchRefusal(need)) return { state };
  const on = state.selected.includes(need.key);
  return { state: { ...state, selected: on ? state.selected.filter((key) => key !== need.key) : [...state.selected, need.key] } };
}

function startBatch(state) {
  const items = batchSteps(state.needs, state.selected).map(({ need, step }) => ({ need, step, values: {} }));
  if (!items.length) return { state };
  return { state: askNext({ ...state, batch: { items, index: 0, promptIndex: 0 } }) };
}

// Every prompt of every step is asked before the one confirm, so nothing runs on a half-answered batch.
function askNext(state) {
  let { index, promptIndex } = state.batch;
  const { items } = state.batch;
  while (index < items.length && promptIndex >= (items[index].step.prompts ?? []).length) { index += 1; promptIndex = 0; }
  if (index >= items.length) return confirmBatch(state);
  const prompt = items[index].step.prompts[promptIndex];
  return { ...state, mode: 'prompt', batch: { ...state.batch, index, promptIndex }, input: prompt.default ?? '' };
}

function confirmBatch(state) {
  const { items } = state.batch;
  const filled = [];
  for (const [index, item] of items.entries()) {
    try { filled.push({ need: item.need, step: item.step, command: fillCommand(item.step, item.values) }); }
    catch (error) {
      return { ...state, mode: 'note', batch: null, note: `This step cannot run safely: [${index + 1}/${items.length}] ${error.message}` };
    }
  }
  return { ...state, mode: 'batch', batch: { ...state.batch, filled }, scroll: 0 };
}

function batchPromptKey(state, key) {
  if (key === 'escape') return { state: { ...state, mode: 'list', batch: null } };
  if (key === 'enter') {
    const { items, index, promptIndex } = state.batch;
    const item = items[index];
    const values = { ...item.values, [item.step.prompts[promptIndex].key]: state.input };
    const updated = items.map((row, at) => (at === index ? { ...row, values } : row));
    return { state: askNext({ ...state, batch: { ...state.batch, items: updated, promptIndex: promptIndex + 1 } }) };
  }
  return editKey(state, key);
}

function batchKey(state, key) {
  if (key === 'y' || key === 'enter') {
    const effect = { batch: { items: state.batch.filled, root: state.root } };
    return { state: { ...state, mode: 'list', batch: null, selected: [] }, effect };
  }
  if (key === 'n' || key === 'escape') return { state: { ...state, mode: 'list', batch: null } };
  return scrollKey(state, key);
}

function scrollKey(state, key) {
  if (key === 'down' || key === 'j') return { state: { ...state, scroll: state.scroll + 1 } };
  if (key === 'up' || key === 'k') return { state: { ...state, scroll: Math.max(0, state.scroll - 1) } };
  return { state };
}

/**
 * Apply one key. Keys are plain characters or the names `enter`, `escape`, `up`, `down`,
 * `backspace` and `ctrl+u`; a space is ' '.
 *
 * @param {any} state
 * @param {string} key
 * @returns {{ state: any, effect?: 'quit' | 'refresh' | { run: { need: any, step: any, command: string, root: string } } | { batch: { items: { need: any, step: any, command: string }[], root: string } } }}
 */
export function press(state, key) {
  if (state.mode === 'prompt') return promptKey(state, key);
  if (key === 'ctrl+c') return { state, effect: 'quit' };
  if (state.mode === 'batch') return batchKey(state, key);
  if (state.mode === 'confirm') {
    if (key === 'y' || key === 'enter') {
      const root = state.need.root ?? state.root;
      return { state: { ...state, mode: 'need' }, effect: { run: { need: state.need, step: state.step, command: state.command, root } } };
    }
    if (key === 'n' || key === 'escape') return { state: { ...state, mode: 'need', step: null } };
    return scrollKey(state, key);
  }
  if (state.mode === 'need') {
    if (key === 'enter') return beginStep(state);
    if (key === 'escape' || key === 'b' || key === 'left') return { state: { ...state, mode: 'list', need: null } };
    if (key === 'q') return { state, effect: 'quit' };
    if (key === 'r') return { state, effect: 'refresh' };
    return { state };
  }
  if (key === 'q' || key === 'escape') return { state, effect: 'quit' };
  // With a selection, r and enter run it; with none they keep their single-need meaning.
  if (state.mode === 'list' && state.selected.length && (key === 'r' || key === 'enter')) return startBatch(state);
  if (key === 'r') return { state, effect: 'refresh' };
  if (state.mode !== 'list' || !state.needs.length) return { state };
  if (key === ' ') return toggle(state);
  const last = state.needs.length - 1;
  if (key === 'down' || key === 'j') return { state: { ...state, cursor: Math.min(last, state.cursor + 1) } };
  if (key === 'up' || key === 'k') return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
  if (key === 'enter' || key === 'right') return { state: { ...state, mode: 'need', need: state.needs[state.cursor] } };
  return { state };
}

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });
const ASCII = /^[\x20-\x7e]$/u;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/u;
const ON = '\x1b[7m';
const OFF = '\x1b[27m';

// Cells a grapheme may take, never fewer than drawn: width tables and zero-width exceptions kept
// missing cases (a heart or keycap with a variation selector) that spilled a line onto extra rows
// and pushed a command's start off the confirm screen. A terminal advances at most two cells per
// grapheme, so two for every non-ASCII code point can only over-count, which only shortens a line.
function cells(text) {
  let sum = 0;
  for (const char of text) sum += ASCII.test(char) ? 1 : 2;
  return sum;
}

// An escape is drawn in reverse video so it never reads the same as a command's literal "\x1b".
function styled(text) {
  return { text: `${ON}${text}${OFF}`, width: text.length, plain: text };
}

function escaped(char) {
  if (ASCII.test(char)) return { text: char, width: 1 };
  const code = char.codePointAt(0);
  return styled(CONTROL.test(char) ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u{${code.toString(16)}}`);
}

// Drawable pieces of a text, never split across lines. A control character drawn raw could move
// the cursor or clear the screen, and a grapheme stacked past four cells could be wider than any
// line, so either is shown one escape per code point; the person reads exactly what runs.
function units(text) {
  const out = [];
  for (const { segment } of GRAPHEMES.segment(String(text))) {
    if (!CONTROL.test(segment) && cells(segment) <= 4) out.push({ text: segment, width: cells(segment) });
    else for (const char of segment) out.push(escaped(char));
  }
  return out;
}

function width(text) {
  return units(text).reduce((sum, unit) => sum + unit.width, 0);
}

// A unit too wide for a whole line is split, never dropped: an escape into its styled characters,
// a raw grapheme into its escapes.
function narrow(unit, room) {
  if (unit.width <= room) return [unit];
  if (unit.plain) return [...unit.plain].map((char) => styled(char));
  return [...unit.text].flatMap((char) => narrow(escaped(char), room));
}

// Display text cut to whole units within the width. Takes raw text only: drawing a line twice
// would escape its own style codes.
function fit(text, cols) {
  let out = '';
  let used = 0;
  for (const unit of units(text)) {
    if (used + unit.width > cols) break;
    out += unit.text;
    used += unit.width;
  }
  return out;
}

function wrap(text, cols) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/u).filter(Boolean)) {
    if (line && width(line) + 1 + width(word) > cols) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

// A command or folder about to be authorized is wrapped at whole units, never dropped: every
// character stays on screen, and a continuation is indented under its first line. The lines are
// final display text, already within the width.
function hardWrap(text, first, rest, cols) {
  const lines = [];
  let line = '';
  let room = Math.max(1, cols - cells(first));
  let used = 0;
  for (const unit of units(text).flatMap((part) => narrow(part, Math.max(1, cols - Math.max(cells(first), cells(rest)))))) {
    if (line && used + unit.width > room) {
      lines.push((lines.length ? rest : first) + line);
      line = '';
      used = 0;
      room = Math.max(1, cols - cells(rest));
    }
    line += unit.text;
    used += unit.width;
  }
  lines.push((lines.length ? rest : first) + line);
  return lines;
}

// A confirm screen keeps its footer on the last row however long it is, so the person can always
// confirm or cancel, and scrolls the rest so no command or folder they authorize is out of reach.
// The body is display lines already within the width.
function paged(body, footer, scroll, rows, cols) {
  const room = Math.max(0, rows - 1);
  const top = Math.min(scroll, Math.max(0, body.length - room));
  // On a narrow screen the scroll hint gives way, so y and n stay readable.
  const more = body.length > room && width(`up/down scroll   ${footer}`) <= cols ? 'up/down scroll   ' : '';
  return [...body.slice(top, top + room), fit(`${more}${footer}`, cols)];
}

function batchLines(state, cols, rows) {
  const { filled } = state.batch;
  const body = [fit(`Run these ${filled.length} steps in order in one new tab?`, cols), ''];
  filled.forEach(({ step, command }, index) => {
    const number = `  ${index + 1}. `;
    const indent = ' '.repeat(number.length);
    body.push(...hardWrap(command, number, indent, cols), ...hardWrap(step.cwd, `${indent}in `, `${indent}   `, cols));
  });
  const note = wrap('Each ask step is marked done when it exits 0. The first step that fails stops the rest.', Math.max(20, cols - 2));
  body.push('', ...note.map((line) => fit(line, cols)), '');
  return paged(body, 'y run all   n cancel', state.scroll, rows, cols);
}

const MARK = { done: '[x]', next: '[>]', waiting: '[ ]' };

function needLines(state, width) {
  const need = state.need;
  const lines = [need.title, ''];
  if (need.why) lines.push(...wrap(need.why, width), '');
  if (need.from) lines.push(`from ${need.from}`, '');
  for (const step of need.steps) {
    const place = stepState(need, step);
    lines.push(`${MARK[place]} ${step.n}. ${step.label ?? step.command}${step.personOnly ? '  (your terminal)' : ''}`);
    lines.push(`      ${step.command}`, `      in ${step.cwd}`);
  }
  lines.push('', nextStep(need) ? 'enter run the next step   esc back   r refresh   q close' : 'Every step is done.   esc back   r refresh   q close');
  return lines;
}

/**
 * Draw a state as at most `rows` lines, each within `cols` cells; escapes are styled in reverse video.
 *
 * @param {any} state
 * @param {number} cols
 * @param {number} rows
 * @returns {string[]}
 */
export function render(state, cols, rows) {
  const width = Math.max(20, cols - 2);
  let lines;
  if (state.mode === 'loading') lines = ['Needs you', '', 'Reading the board...'];
  else if (state.mode === 'note') lines = ['Needs you', '', ...wrap(state.note, width), '', 'r refresh   q close'];
  else if (state.mode === 'list' && !state.needs.length && !state.boards.some((board) => 'note' in board)) lines = ['Needs you', '', 'Nothing needs you.', '', 'r refresh   q close'];
  else if (state.mode === 'list') {
    lines = ['Needs you', ''];
    const row = (need) => {
      const index = state.needs.indexOf(need);
      const done = need.steps.filter((step) => step.done).length;
      const pick = batchRefusal(need) ? '[-]' : state.selected.includes(need.key) ? '[x]' : '[ ]';
      return `${index === state.cursor ? '>' : ' '} ${pick} ${need.title}  [${need.kind ?? need.source}] ${done}/${need.steps.length}`;
    };
    // One board reads as before; several each get a heading, with a failed board's note under its own.
    if (state.boards.length > 1) {
      state.boards.forEach((board, at) => {
        if (at) lines.push('');
        lines.push(board.name);
        if ('note' in board) lines.push(...wrap(board.note, width - 2).map((line) => `  ${line}`));
        else {
          const mine = state.needs.filter((need) => need.root === board.root);
          lines.push(...(mine.length ? mine.map(row) : ['  Nothing needs you here.']));
        }
      });
    } else lines.push(...state.needs.map(row));
    const why = state.needs.length ? batchRefusal(state.needs[state.cursor]) : '';
    if (why) lines.push('', ...wrap(`Cannot select: ${why}`, width));
    const count = state.selected.length;
    lines.push('', count ? `up/down choose   space select   r/enter run selected (${count})   q close` : 'up/down choose   space select   enter open   r refresh   q close');
  } else if (state.mode === 'need') lines = needLines(state, width);
  else if (state.mode === 'batch') return batchLines(state, cols, rows);
  else if (state.mode === 'prompt' && state.batch) {
    const { items, index, promptIndex } = state.batch;
    const { need, step } = items[index];
    const prompt = step.prompts[promptIndex];
    lines = [`Run selected [${index + 1}/${items.length}]: ${need.title}`, '', `Step ${step.n}: ${step.label ?? ''}`, '', `${prompt.label ?? prompt.key}:`, `> ${state.input}_`, '', 'enter accept   esc cancel the run   ctrl+u clear'];
  } else if (state.mode === 'prompt') {
    const prompt = state.step.prompts[state.promptIndex];
    lines = [state.need.title, '', `Step ${state.step.n}: ${state.step.label ?? ''}`, '', `${prompt.label ?? prompt.key}:`, `> ${state.input}_`, '', 'enter accept   esc cancel   ctrl+u clear'];
  } else {
    const body = [fit(state.need.title, cols), '', fit(`Run step ${state.step.n} in a new tab?`, cols), '', ...hardWrap(state.command, '  ', '    ', cols), ...hardWrap(state.step.cwd, '  in ', '     ', cols), ''];
    if (state.need.source === 'ask') body.push(...wrap('When it exits 0 the step is marked done on the board.', width).map((line) => fit(line, cols)), '');
    return paged(body, 'y run   n cancel', state.scroll, rows, cols);
  }
  return lines.slice(0, rows).map((line) => fit(line, cols));
}
