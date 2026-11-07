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
  return { mode: 'loading', needs: [], root: '', cursor: 0, need: null, step: null, promptIndex: 0, values: {}, input: '', command: '', note: '', selected: [], batch: null, scroll: 0 };
}

/**
 * The state after the board was read, keeping the cursor on the same need when it is still there.
 *
 * @param {any} state
 * @param {{ needs: any[], root: string } | { note: string }} read
 * @returns {any}
 */
export function loaded(state, read) {
  if ('note' in read) return { ...state, mode: 'note', needs: [], note: read.note };
  const id = state.needs[state.cursor]?.id;
  const kept = read.needs.findIndex((need) => need.id === id);
  // A need that left the board or can no longer run safely drops out of the selection.
  const selected = state.selected.filter((sel) => read.needs.some((need) => need.id === sel && !batchRefusal(need)));
  return { ...state, mode: 'list', needs: read.needs, root: read.root, cursor: Math.max(0, kept), need: null, step: null, selected, batch: null };
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
  const on = state.selected.includes(need.id);
  return { state: { ...state, selected: on ? state.selected.filter((id) => id !== need.id) : [...state.selected, need.id] } };
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
      return { state: { ...state, mode: 'need' }, effect: { run: { need: state.need, step: state.step, command: state.command, root: state.root } } };
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

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/u).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

// A command or folder about to be authorized is cut at the character, never dropped: every
// character stays on screen, and a continuation is indented under its first line.
function hardWrap(text, first, rest, cols) {
  const chars = [...String(text)];
  const lines = [];
  let prefix = first;
  do {
    const room = Math.max(1, cols - prefix.length);
    lines.push(prefix + chars.splice(0, room).join(''));
    prefix = rest;
  } while (chars.length);
  return lines;
}

// A confirm screen keeps its footer on the last row however long it is, so the person can always
// confirm or cancel, and scrolls the rest so no command or folder they authorize is out of reach.
function paged(body, footer, scroll, rows) {
  const room = Math.max(0, rows - 1);
  const top = Math.min(scroll, Math.max(0, body.length - room));
  const more = body.length > room ? 'up/down scroll   ' : '';
  return [...body.slice(top, top + room), `${more}${footer}`];
}

function batchLines(state, cols, rows) {
  const { filled } = state.batch;
  const body = [`Run these ${filled.length} steps in order in one new tab?`, ''];
  filled.forEach(({ step, command }, index) => {
    const number = `  ${index + 1}. `;
    const indent = ' '.repeat(number.length);
    body.push(...hardWrap(command, number, indent, cols), ...hardWrap(step.cwd, `${indent}in `, `${indent}   `, cols));
  });
  body.push('', ...wrap('Each ask step is marked done when it exits 0. The first step that fails stops the rest.', Math.max(20, cols - 2)), '');
  return paged(body, 'y run all   n cancel', state.scroll, rows);
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
 * Draw a state as at most `rows` lines, each cut to `cols` characters.
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
  else if (state.mode === 'list' && !state.needs.length) lines = ['Needs you', '', 'Nothing needs you.', '', 'r refresh   q close'];
  else if (state.mode === 'list') {
    lines = ['Needs you', ''];
    state.needs.forEach((need, index) => {
      const done = need.steps.filter((step) => step.done).length;
      const pick = batchRefusal(need) ? '[-]' : state.selected.includes(need.id) ? '[x]' : '[ ]';
      lines.push(`${index === state.cursor ? '>' : ' '} ${pick} ${need.title}  [${need.kind ?? need.source}] ${done}/${need.steps.length}`);
    });
    const why = batchRefusal(state.needs[state.cursor]);
    if (why) lines.push('', ...wrap(`Cannot select: ${why}`, width));
    const count = state.selected.length;
    lines.push('', count ? `up/down choose   space select   r/enter run selected (${count})   q close` : 'up/down choose   space select   enter open   r refresh   q close');
  } else if (state.mode === 'need') lines = needLines(state, width);
  else if (state.mode === 'batch') return batchLines(state, cols, rows).map((line) => [...line].slice(0, cols).join(''));
  else if (state.mode === 'prompt' && state.batch) {
    const { items, index, promptIndex } = state.batch;
    const { need, step } = items[index];
    const prompt = step.prompts[promptIndex];
    lines = [`Run selected [${index + 1}/${items.length}]: ${need.title}`, '', `Step ${step.n}: ${step.label ?? ''}`, '', `${prompt.label ?? prompt.key}:`, `> ${state.input}_`, '', 'enter accept   esc cancel the run   ctrl+u clear'];
  } else if (state.mode === 'prompt') {
    const prompt = state.step.prompts[state.promptIndex];
    lines = [state.need.title, '', `Step ${state.step.n}: ${state.step.label ?? ''}`, '', `${prompt.label ?? prompt.key}:`, `> ${state.input}_`, '', 'enter accept   esc cancel   ctrl+u clear'];
  } else {
    const body = [state.need.title, '', `Run step ${state.step.n} in a new tab?`, '', ...hardWrap(state.command, '  ', '    ', cols), ...hardWrap(state.step.cwd, '  in ', '     ', cols), ''];
    if (state.need.source === 'ask') body.push(...wrap('When it exits 0 the step is marked done on the board.', width), '');
    lines = paged(body, 'y run   n cancel', state.scroll, rows);
  }
  return lines.slice(0, rows).map((line) => [...line].slice(0, cols).join(''));
}
