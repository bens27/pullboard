/**
 * The "Needs you" popup as pure state: a key press moves the state and may ask the panel for an
 * effect (quit, refresh or run a step), and render draws a state as lines [B26]. Keeping the screen
 * logic free of the terminal lets tests prove that only a need's next step can ever run.
 */
import { fillCommand, nextStep, stepState } from './needs.js';

/** @returns {any} */
export function initialState() {
  return { mode: 'loading', needs: [], root: '', cursor: 0, need: null, step: null, promptIndex: 0, values: {}, input: '', command: '', note: '' };
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
  return { ...state, mode: 'list', needs: read.needs, root: read.root, cursor: Math.max(0, kept), need: null, step: null };
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

// A template fillCommand refuses (a placeholder inside quotes) becomes a note and never runs,
// checked before the prompts so the person does not answer them in vain.
function refusal(step, values) {
  try { fillCommand(step, values); return null; }
  catch (error) { return (state) => ({ ...state, mode: 'note', step: null, command: '', note: `This step cannot run safely: ${error.message}` }); }
}

function confirm(state) {
  const refused = refusal(state.step, state.values);
  if (refused) return refused(state);
  return { ...state, mode: 'confirm', command: fillCommand(state.step, state.values) };
}

function promptKey(state, key) {
  const prompts = state.step.prompts;
  if (key === 'escape') return { state: { ...state, mode: 'need', step: null } };
  if (key === 'enter') {
    const values = { ...state.values, [prompts[state.promptIndex].key]: state.input };
    const promptIndex = state.promptIndex + 1;
    if (promptIndex >= prompts.length) return { state: confirm({ ...state, values }) };
    return { state: { ...state, values, promptIndex, input: prompts[promptIndex].default ?? '' } };
  }
  if (key === 'backspace') return { state: { ...state, input: [...state.input].slice(0, -1).join('') } };
  if (key === 'ctrl+u') return { state: { ...state, input: '' } };
  if ([...key].length === 1) return { state: { ...state, input: state.input + key } };
  return { state };
}

/**
 * Apply one key. Keys are plain characters or the names `enter`, `escape`, `up`, `down`,
 * `backspace` and `ctrl+u`.
 *
 * @param {any} state
 * @param {string} key
 * @returns {{ state: any, effect?: 'quit' | 'refresh' | { run: { need: any, step: any, command: string, root: string } } }}
 */
export function press(state, key) {
  if (state.mode === 'prompt') return promptKey(state, key);
  if (key === 'ctrl+c') return { state, effect: 'quit' };
  if (state.mode === 'confirm') {
    if (key === 'y' || key === 'enter') {
      return { state: { ...state, mode: 'need' }, effect: { run: { need: state.need, step: state.step, command: state.command, root: state.root } } };
    }
    if (key === 'n' || key === 'escape') return { state: { ...state, mode: 'need', step: null } };
    return { state };
  }
  if (state.mode === 'need') {
    if (key === 'enter') return beginStep(state);
    if (key === 'escape' || key === 'b' || key === 'left') return { state: { ...state, mode: 'list', need: null } };
    if (key === 'q') return { state, effect: 'quit' };
    if (key === 'r') return { state, effect: 'refresh' };
    return { state };
  }
  if (key === 'q' || key === 'escape') return { state, effect: 'quit' };
  if (key === 'r') return { state, effect: 'refresh' };
  if (state.mode !== 'list' || !state.needs.length) return { state };
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
      lines.push(`${index === state.cursor ? '>' : ' '} ${need.title}  [${need.kind ?? need.source}] ${done}/${need.steps.length}`);
    });
    lines.push('', 'up/down choose   enter open   r refresh   q close');
  } else if (state.mode === 'need') lines = needLines(state, width);
  else if (state.mode === 'prompt') {
    const prompt = state.step.prompts[state.promptIndex];
    lines = [state.need.title, '', `Step ${state.step.n}: ${state.step.label ?? ''}`, '', `${prompt.label ?? prompt.key}:`, `> ${state.input}_`, '', 'enter accept   esc cancel   ctrl+u clear'];
  } else {
    lines = [state.need.title, '', `Run step ${state.step.n} in a new tab?`, '', `  ${state.command}`, `  in ${state.step.cwd}`, ''];
    if (state.need.source === 'ask') lines.push('When it exits 0 the step is marked done on the board.', '');
    lines.push('y run   n cancel');
  }
  return lines.slice(0, rows).map((line) => [...line].slice(0, cols).join(''));
}
