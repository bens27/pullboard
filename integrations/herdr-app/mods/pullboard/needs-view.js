/**
 * The panel's Needs you section [B26]: what needs the person, each step in order, answers for the
 * next step's prompts, and a confirmed run in a new tab of the Needs you space. Several needs can
 * be selected and run as one batch: every prompt first, one confirm, then one tab.
 */
import { div } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import { theme, exec, readTextFile, run, spaces } from 'herdr';
import { NEEDS_SPACE, fillCommand, planRun, runnableStep, stepStates } from './needs-model.js';
import { readNeedsList } from './cli.js';
import {
  BatchFlow,
  selectable,
  toggleNeed,
} from './needs-batch.js';

const MARK = { done: '✓', next: '→', later: '·' };

export class NeedsSection {
  read = null;
  loading = false;
  /** The step being prepared: its need, number and one input per prompt. */
  draft = null;
  message = null;
  /** Ids of the needs ticked for a batch. */
  selected = new Set();
  /** The batch between Run selected and its confirm, with one input for the prompt it asks now. */
  batch = null;

  /** Read the needs again unless a read is already running; a stale draft is dropped. */
  refresh(cx, board, file) {
    if (this.loading || (!board && !file)) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        this.read = await readNeedsList(exec, readTextFile, board, file);
        this.board = board;
        if (this.draft && !runnableStep(this.need(this.draft.id) ?? {}, this.draft.n)) this.draft = null;
        this.settleBatch();
      } finally { this.loading = false; cx.notify(); }
    });
  }

  need(id) {
    return this.read?.state === 'ok' ? this.read.needs.find((n) => n.id === id) ?? null : null;
  }

  /** Open a step for running: inputs start at each prompt's default, and nothing runs yet. */
  prepare(need, step, cx) {
    const inputs = (step.prompts ?? []).map((p) => {
      const state = InputState.new({ value: p.default ?? '', placeholder: p.label ?? p.key });
      state.on('change', (_e, cx) => cx.notify());
      return { key: p.key, label: p.label ?? p.key, state };
    });
    this.draft = { id: need.id, n: step.n, inputs };
    this.message = null;
    inputs[0]?.state.focus();
    cx.notify();
  }

  values() {
    return Object.fromEntries((this.draft?.inputs ?? []).map((i) => [i.key, i.state.value()]));
  }

  /** The person confirmed: open the step's tab, which marks an ask's step done itself on exit 0. */
  confirm(cx) {
    const need = this.need(this.draft?.id);
    if (!need) { this.draft = null; cx.notify(); return; }
    const plan = planRun({ need, n: this.draft.n, values: this.values(), root: this.read.root ?? this.board, spaces: spaces() });
    if ('refused' in plan) { this.message = plan.refused; cx.notify(); return; }
    try {
      run(plan.launch.command, plan.launch.args);
      this.message = `Opened "${plan.launch.args.tab ?? plan.launch.args.name}" in ${NEEDS_SPACE}.`;
      this.draft = null;
    } catch (error) { this.message = 'Could not open the tab: ' + String(error?.message ?? error); }
    cx.notify();
  }

  /**
   * After a read, keep only ticks on needs that can still join, and drop a batch whose steps the
   * board has moved past, since its confirm would run what the person no longer sees.
   */
  settleBatch() {
    this.selected = new Set([...this.selected].filter((id) => {
      const need = this.need(id);
      return need && !selectable(need);
    }));
    const stale = this.batch?.flow.entries.some(({ need, step }) => {
      const fresh = this.need(need.id);
      return !fresh || !(fresh.steps ?? []).some((s) => s.n === step.n && !s.done);
    });
    if (stale) { this.batch = null; this.message = 'The needs changed while the batch was open; nothing ran. Select again.'; }
  }

  toggle(need, cx) {
    const result = toggleNeed(this.selected, need);
    this.selected = result.selected;
    this.message = result.refused ?? null;
    cx.notify();
  }

  /** Run selected: start asking the batch's prompts; nothing runs until its one confirm. */
  startBatch(cx) {
    const needs = this.read?.state === 'ok' ? this.read.needs : [];
    const flow = new BatchFlow(needs, this.selected);
    if (!flow.entries.length) { this.message = 'Nothing selected can run now.'; cx.notify(); return; }
    this.draft = null;
    this.message = null;
    this.batch = { flow, input: null };
    this.askNext();
    cx.notify();
  }

  /** One input for the prompt the batch asks now, prefilled with its default. */
  askNext() {
    const prompt = this.batch.flow.prompt();
    if (!prompt) { this.batch.input = null; return; }
    const state = InputState.new({ value: prompt.value, placeholder: prompt.label });
    state.on('change', (_e, cx) => cx.notify());
    this.batch.input = state;
    state.focus();
  }

  answerBatch(cx) {
    const refused = this.batch.flow.answer(this.batch.input.value());
    this.message = refused;
    if (!refused) this.askNext();
    cx.notify();
  }

  cancelBatch(cx) {
    this.batch?.flow.cancel();
    this.batch = null;
    this.message = 'Batch cancelled; nothing ran.';
    cx.notify();
  }

  /** The person confirmed the numbered list: one tab runs every step, in order. */
  confirmBatch(cx) {
    const root = this.read?.state === 'ok' ? this.read.root ?? this.board : this.board;
    try {
      const result = this.batch.flow.confirm({ root, spaces: spaces(), run });
      if ('refused' in result) { this.message = result.refused; cx.notify(); return; }
      this.message = `Opened "${result.launch.args.tab ?? result.launch.args.name}" in ${NEEDS_SPACE} with ${result.count} steps.`;
      this.batch = null;
      this.selected = new Set();
    } catch (error) { this.message = 'Could not open the tab: ' + String(error?.message ?? error); }
    cx.notify();
  }

  /** The batch's current prompt, or once all are answered, the one numbered confirm screen. */
  batchRows() {
    const t = theme();
    const { flow, input } = this.batch;
    const prompt = flow.prompt();
    const box = v_flex().id('needs-batch').gap(4).p(8).rounded(6).bg(t.surface);
    if (prompt) {
      return box.child(div().font_semibold().child(`Batch [${prompt.k}/${prompt.total}] ${prompt.title} · ${prompt.step}`))
        .child(div().text_size(11).text_color(t.muted).child(prompt.label))
        .child(Input.new(input).h(28).px(6).rounded(4).border_1().border_color(t.input).bg(t.background).text_color(t.foreground))
        .child(h_flex().gap(8)
          .child(this.button('needs-batch-next', 'Next', (_e, cx) => this.answerBatch(cx), true))
          .child(this.button('needs-batch-cancel', 'Cancel', (_e, cx) => this.cancelBatch(cx))));
    }
    const review = flow.review();
    if ('refused' in review) {
      return box.child(div().text_size(12).text_color(t.blocked).child(review.refused))
        .child(this.button('needs-batch-cancel', 'Cancel', (_e, cx) => this.cancelBatch(cx)));
    }
    box.child(div().font_semibold().child(`Run these ${review.length} steps, in order, in one new tab?`));
    for (const step of review) {
      box.child(v_flex().gap(2).p(6).rounded(4).bg(t.background)
        .child(div().text_size(12).child(`${step.k}. ${step.command}`))
        .child(div().text_size(11).text_color(t.muted).child(`in ${step.cwd}`)));
    }
    return box.child(div().text_size(11).text_color(t.muted).child('The tab stops at the first step that fails.'))
      .child(h_flex().gap(8)
        .child(this.button('needs-batch-confirm', `Confirm: run ${review.length} steps in new tab`, (_e, cx) => this.confirmBatch(cx), true))
        .child(this.button('needs-batch-cancel', 'Cancel', (_e, cx) => this.cancelBatch(cx))));
  }

  /** The tick for a batch, or why the need cannot join one. */
  selectRow(need) {
    const t = theme();
    const why = selectable(need);
    if (why) return div().text_size(11).text_color(t.dim).child('Not selectable: ' + why);
    const on = this.selected.has(need.id);
    return h_flex().child(this.button(`need-select-${need.id}`, on ? '[x] Selected' : '[ ] Select', (_e, cx) => this.toggle(need, cx), on));
  }

  button(id, label, handler, primary = false) {
    const t = theme();
    return div().id(id).px(8).py(2).rounded(4).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.accent).cursor_pointer().on_click(handler).child(label);
  }

  /** The filled command, or why it cannot be filled, so a bad template shows instead of throwing. */
  preview(step) {
    try { return fillCommand(step, this.values()); } catch (error) { return error.message; }
  }

  /** The prepared step: an input per prompt, the command it will run, and the confirm button. */
  draftRows(need, step) {
    const t = theme();
    const rows = this.draft.inputs.map((input) => v_flex().gap(2)
      .child(div().text_size(11).text_color(t.muted).child(input.label))
      .child(Input.new(input.state).h(28).px(6).rounded(4).border_1().border_color(t.input).bg(t.background).text_color(t.foreground)));
    rows.push(div().text_size(11).text_color(t.muted).child(`in ${step.cwd}`));
    rows.push(div().text_size(12).p(6).rounded(4).bg(t.background).child(this.preview(step)));
    rows.push(h_flex().gap(8)
      .child(this.button(`need-confirm-${need.id}`, 'Confirm: run in new tab', (_e, cx) => this.confirm(cx), true))
      .child(this.button(`need-cancel-${need.id}`, 'Cancel', (_e, cx) => { this.draft = null; cx.notify(); })));
    return rows;
  }

  stepRow(need, step) {
    const t = theme();
    const color = step.state === 'next' ? t.foreground : t.muted;
    const row = h_flex().id(`need-${need.id}-step-${step.n}`).gap(6).text_size(12).items_center()
      .child(div().text_color(step.state === 'done' ? t.done : color).child(MARK[step.state]))
      .child(div().flex_1().text_color(color).child(`${step.n}. ${step.label ?? step.command}`))
      .when(Boolean(step.personOnly), (el) => el.child(div().text_size(11).text_color(t.dim).child('you only')));
    const preparing = this.draft?.id === need.id && this.draft.n === step.n;
    if (step.state !== 'next' || preparing) return row;
    return row.child(this.button(`need-run-${need.id}-${step.n}`, 'Run in new tab…', (_e, cx) => this.prepare(need, step, cx)));
  }

  card(need) {
    const t = theme();
    const steps = stepStates(need);
    const card = v_flex().id('need-' + need.id).gap(4).p(8).rounded(6).bg(t.surface)
      .child(div().font_semibold().child(need.title ?? need.id))
      .when(Boolean(need.why), (el) => el.child(div().text_size(12).text_color(t.muted).child(need.why)))
      .when(Boolean(need.from), (el) => el.child(div().text_size(11).text_color(t.dim).child('from ' + need.from)))
      .child(this.selectRow(need));
    for (const step of steps) {
      card.child(this.stepRow(need, step));
      if (this.draft?.id === need.id && this.draft.n === step.n && step.state === 'next') card.children(this.draftRows(need, step));
    }
    return card;
  }

  /** The section's title and rows; a pullboard without `needs` gets one quiet line. */
  render() {
    const t = theme();
    const read = this.read;
    const count = read?.state === 'ok' ? read.needs.length : '?';
    const section = v_flex().id('needs').gap(6).child(div().font_semibold().child(`Needs you (${count})`));
    if (!read) return section.child(div().text_size(12).text_color(t.muted).child('Reading what needs you…'));
    if (read.state === 'missing') return section.child(div().text_size(12).text_color(t.muted).child('This pullboard has no needs command yet.'));
    if (read.state === 'error') return section.child(div().text_size(12).text_color(t.blocked).child(read.message));
    if (!read.needs.length) section.child(div().text_size(12).text_color(t.muted).child('Nothing needs you.'));
    if (this.batch) section.child(this.batchRows());
    else if (this.selected.size) {
      section.child(h_flex().child(this.button('needs-run-selected', `Run selected (${this.selected.size})`, (_e, cx) => this.startBatch(cx), true)));
    }
    section.children(read.needs.map((need) => this.card(need)));
    if (this.message) section.child(div().text_size(12).text_color(t.muted).child(this.message));
    return section;
  }
}
