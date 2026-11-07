/**
 * Pure model for running several needs as one batch [B26]: which needs can join, the steps they
 * bring in list order, collecting every prompt before anything runs, and the one script a single
 * new tab runs. Every command in it comes from fillCommand, as a single run's does.
 */
import { askId, fillCommand, launchCommand, runnableStep, shellQuote } from './needs-model.js';

/**
 * The steps a selected need brings, or why it cannot join. An ask brings every step left, since
 * the person authorizes it once; a board need brings its next step, as the board names only one.
 *
 * @param {any} need
 * @returns {{ steps: any[] } | { why: string }}
 */
export function batchSteps(need) {
  const first = need.next == null ? null : runnableStep(need, need.next);
  if (!first) return { why: 'no step to run now' };
  const steps = need.source === 'ask'
    ? (need.steps ?? []).filter((s) => !s.done && s.n >= first.n).sort((a, b) => a.n - b.n)
    : [first];
  for (const step of steps) {
    if (!step.cwd) return { why: `step ${step.n} names no folder to run in` };
    // A stand-in answer tests the template alone, so a later default the person may change cannot refuse it.
    const stand = Object.fromEntries((step.prompts ?? []).map((p) => [p.key, 'x']));
    try { fillCommand(step, stand); } catch (error) { return { why: `step ${step.n}: ${error.message}` }; }
  }
  return { steps };
}

/**
 * @param {any} need
 * @returns {string|null} why the need cannot be selected, or null when it can
 */
export function selectable(need) {
  const result = batchSteps(need);
  return 'why' in result ? result.why : null;
}

/**
 * Select or unselect a need; one that cannot join stays out and says why.
 *
 * @param {Set<string>} selected
 * @param {any} need
 * @returns {{ selected: Set<string>, refused?: string }}
 */
export function toggleNeed(selected, need) {
  const next = new Set(selected);
  if (next.delete(need.id)) return { selected: next };
  const why = selectable(need);
  if (why) return { selected: next, refused: `${need.title ?? need.id}: ${why}` };
  next.add(need.id);
  return { selected: next };
}

/**
 * The batch's steps in list order, whatever order they were selected in.
 *
 * @param {any[]} needs
 * @param {Set<string>} selected
 * @returns {{ need: any, step: any }[]}
 */
export function batchEntries(needs, selected) {
  return (needs ?? []).filter((need) => selected.has(need.id)).flatMap((need) => {
    const result = batchSteps(need);
    return 'steps' in result ? result.steps.map((step) => ({ need, step })) : [];
  });
}

/**
 * The script the batch's tab runs. Each command runs in its own subshell, after a cd to its
 * folder, so an `exit` or `cd` in one cannot end the batch or move the next step; the first
 * non-zero exit stops the rest, and each ask step that exits 0 is marked done as the person.
 *
 * @param {{ steps: { label: string, cwd: string, command: string, askId?: string|null, step?: number }[], root?: string|null }} batch
 * @returns {string}
 */
export function batchScript({ steps, root = null }) {
  const total = steps.length;
  const into = root ? `cd ${shellQuote(root)} && ` : '';
  const lines = ['pb_stop=0'];
  steps.forEach((s, i) => {
    const k = i + 1;
    const tag = `[${k}/${total}]`;
    lines.push(`pb_r${k}='not run'`);
    lines.push('if [ "$pb_stop" -eq 0 ]; then');
    lines.push(`echo ${shellQuote(`${tag} ${s.label}  (in ${s.cwd})`)}`);
    lines.push('(', `cd ${shellQuote(s.cwd)} || exit`, s.command, ')', 'pb_status=$?');
    lines.push(`if [ "$pb_status" -eq 0 ]; then pb_r${k}=done`);
    if (s.askId != null) lines.push(`(${into}pullboard ask done ${shellQuote(s.askId)} --step ${Number(s.step)} --as person)`);
    lines.push(`else pb_r${k}=failed; pb_stop=1; echo "stopped at ${tag}: exit $pb_status; later steps not run"; fi`);
    lines.push('fi');
  });
  lines.push('echo');
  steps.forEach((s, i) => lines.push(`echo "[${i + 1}/${total}] $pb_r${i + 1}: "${shellQuote(s.label)}`));
  lines.push('exec /bin/zsh -l');
  return lines.join('\n');
}

/**
 * Fill every step of a batch and build its one tab, or refuse the whole batch.
 *
 * @param {{ entries: { need: any, step: any }[], values: Record<string, string>[], root?: string|null, spaces: any[] }} input
 * @returns {{ steps: { k: number, label: string, cwd: string, command: string, askId: string|null, step: number }[], launch: { command: string, args: Record<string, unknown> } } | { refused: string }}
 */
export function planBatch({ entries, values, root = null, spaces }) {
  if (!entries.length) return { refused: 'nothing is selected' };
  const steps = [];
  for (const [i, { need, step }] of entries.entries()) {
    let command;
    try { command = fillCommand(step, values[i] ?? {}); } catch (error) { return { refused: `[${i + 1}/${entries.length}] ${error.message}` }; }
    const label = `${need.title ?? need.id} · ${step.label ?? 'step ' + step.n}`.replace(/[\n\r\0]/g, ' ');
    steps.push({ k: i + 1, label, cwd: step.cwd, command, askId: askId(need), step: step.n });
  }
  const script = batchScript({ steps, root });
  return { steps, launch: launchCommand(spaces, { name: `Needs you · ${steps.length} steps`, cwd: steps[0].cwd, script }) };
}

/**
 * One batch from Run selected to confirm: each prompt of each step in order, then one review of
 * every filled command. Only confirm opens the tab, and never after cancel.
 */
export class BatchFlow {
  /** @param {any[]} needs @param {Set<string>} selected */
  constructor(needs, selected) {
    this.entries = batchEntries(needs, selected);
    this.values = this.entries.map(() => ({}));
    this.queue = this.entries.flatMap(({ step }, i) => (step.prompts ?? []).map((p) => ({ i, p })));
    this.at = 0;
    this.cancelled = false;
  }

  /** The prompt to ask now, prefilled with its default, or null once every prompt is answered. */
  prompt() {
    const item = this.queue[this.at];
    if (!item) return null;
    const { i, p } = item;
    const { need, step } = this.entries[i];
    return { k: i + 1, total: this.entries.length, key: p.key, label: p.label ?? p.key, value: p.default ?? '', title: need.title ?? need.id, step: step.label ?? 'step ' + step.n };
  }

  /** Take the answer to the current prompt; a refusal keeps the prompt open. */
  answer(value) {
    const item = this.queue[this.at];
    if (!item) return 'no prompt is waiting';
    const values = { ...this.values[item.i], [item.p.key]: String(value) };
    try { fillCommand(this.entries[item.i].step, values); } catch (error) { return error.message; }
    this.values[item.i] = values;
    this.at += 1;
    return null;
  }

  /** Every filled command, numbered with its folder, for the one confirm screen. */
  review() {
    const plan = planBatch({ entries: this.entries, values: this.values, spaces: [] });
    return 'refused' in plan ? plan : plan.steps;
  }

  cancel() { this.cancelled = true; }

  /** Open the batch's one tab through `run`, once every prompt is answered and nothing cancelled. */
  confirm({ root = null, spaces, run }) {
    if (this.cancelled) return { refused: 'the batch was cancelled; nothing ran' };
    if (this.prompt()) return { refused: 'a prompt is still waiting for an answer' };
    const plan = planBatch({ entries: this.entries, values: this.values, root, spaces });
    if ('refused' in plan) return plan;
    run(plan.launch.command, plan.launch.args);
    this.cancelled = true;
    return { count: plan.steps.length, launch: plan.launch };
  }
}
