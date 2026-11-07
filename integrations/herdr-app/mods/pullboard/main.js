/**
 * Herdr panel for a Pullboard board [B26]: why work is halted, which seats are live and what they
 * hold, test capacity with slot controls, and flagged halts that have no recorded reason.
 */
import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { theme, props, focused, exec } from 'herdr';
import { boardModel, slotMove } from './read-model.js';
import { readBoard, runMove } from './cli.js';

// Each refresh starts five CLI reads; 15 s keeps the panel current without a steady load.
const POLL_MS = 15000;

export default class Pullboard extends View {
  board = null;
  reads = null;
  loading = false;
  moveBusy = false;
  moveMessage = null;

  /** Pick the board folder and start polling. */
  init(_props, cx) {
    this.props = props() ?? {};
    this.refresh(cx);
    this.pollTask = cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
  }

  /** The board folder: the `board` prop, else the focused pane's folder at each refresh. */
  folder() {
    return this.props.board || focused()?.cwd || null;
  }

  /** Read the board again unless a read is already running. */
  refresh(cx) {
    if (this.loading) return;
    const board = this.folder();
    if (!board) { this.reads = { errors: ['No board folder: set the board prop or focus a pane in a board.'] }; cx.notify(); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try { this.reads = await readBoard(exec, board); this.board = board; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  /** Stop polling when Herdr closes the panel. */
  close() { this.pollTask?.cancel(); }

  /** Change gateSlots or browserSlots by one through `pullboard settings`, then read again. */
  move(name, delta, capacity, cx) {
    if (this.moveBusy || !this.board) return;
    const step = slotMove(name, delta, { gateSlots: capacity.gateSlots, browserSlots: capacity.browserSlots, runners: capacity.runners.length });
    if ('refused' in step) { this.moveMessage = step.refused; cx.notify(); return; }
    this.moveBusy = true;
    const board = this.board;
    cx.spawn(async (cx) => {
      try { this.moveMessage = (await runMove(exec, board, step.args)).message; }
      finally { this.moveBusy = false; cx.notify(); this.refresh(cx); }
    });
  }

  /** A small click-only button. */
  button(id, label, handler) {
    return div().id(id).px(8).py(2).rounded(4).bg(theme().raised).text_color(theme().accent).on_click(handler).child(label);
  }

  /** A section with a bold title and its rows. */
  section(id, title, rows) {
    return v_flex().id(id).gap(6).child(div().font_semibold().child(title)).children(rows);
  }

  /** One flagged halt: what is wrong, the recommendation and the command that acts on it. */
  flagRow(flag) {
    const t = theme();
    return v_flex().id('flag-' + flag.item).gap(2).p(8).rounded(6).bg(t.surface)
      .child(div().child(`${flag.subject} ${flag.title}`))
      .child(div().text_size(12).text_color(t.blocked).child('No recorded reason: ' + flag.problem))
      .child(div().text_size(12).text_color(t.accent).child('Recommend: ' + flag.recommendation))
      .child(div().text_size(11).text_color(t.muted).child(flag.command));
  }

  /** One halt the board explains, with its next step and who takes it. */
  haltRow(row) {
    const t = theme();
    return v_flex().id('halt-' + row.key).gap(2).p(8).rounded(6).bg(t.surface)
      .child(div().child(`${row.subject} ${row.title ?? ''}`))
      .child(div().text_size(12).child('Why: ' + row.why))
      .child(div().text_size(12).text_color(t.accent).child('Next: ' + row.next + (row.owner ? ' (' + row.owner + ')' : '')))
      .when(Boolean(row.command), (el) => el.child(div().text_size(11).text_color(t.muted).child(row.command)));
  }

  /** One seat: presence, lane, route, model and the items it holds. */
  seatRow(seat) {
    const t = theme();
    const color = seat.presence === 'live' ? t.accent : seat.presence === 'idle' ? t.foreground : t.muted;
    const holds = seat.holds.length ? 'holds ' + seat.holds.map((h) => '#' + h.item).join(', ') : 'holds nothing';
    return h_flex().id('seat-' + seat.id).gap(8).text_size(12)
      .child(div().text_color(color).child(seat.presence))
      .child(div().child(`${seat.id} · ${seat.lane} · ${seat.route}${seat.model ? ' · ' + seat.model : ''} · ${holds}`));
  }

  /** One slot kind with its use and the −/+ controls. */
  slotRow(name, label, use, capacity, cx) {
    const t = theme();
    return h_flex().id('slots-' + name).gap(8).text_size(12)
      .child(div().child(`${label}: ${use.used}/${use.capacity} used, ${use.free} free${use.waiting ? ', ' + use.waiting + ' waiting' : ''}`))
      .child(this.button(name + '-down', '−', (_e, cx) => this.move(name, -1, capacity, cx)))
      .child(this.button(name + '-up', '+', (_e, cx) => this.move(name, 1, capacity, cx)))
      .when(this.moveBusy, (el) => el.child(div().text_color(t.muted).child('…')));
  }

  /** Draw the panel from the latest reads. */
  render(cx) {
    const t = theme();
    const reads = this.reads ?? { errors: [] };
    const model = boardModel({ ...reads, now: Date.now() });
    const root = v_flex().id('pullboard').size_full().gap(12).p(14).bg(t.chrome).text_color(t.foreground).text_size(13).overflow_y_scrollbar()
      .child(h_flex().justify_between().child(div().font_semibold().child('Pullboard'))
        .child(div().id('refresh').on_click((_e, cx) => this.refresh(cx)).text_color(t.accent).child(this.loading ? 'Reading…' : 'Refresh')))
      .child(div().text_size(11).text_color(t.muted).child(this.board ?? this.folder() ?? 'No board folder'));
    for (const error of model.errors) root.child(div().text_size(12).text_color(t.blocked).child(error));
    if (!this.reads) return root.child(div().text_color(t.muted).child('Reading the board…'));
    root.child(this.section('flags', `Needs attention (${model.flags.length})`,
      model.flags.length ? model.flags.map((f) => this.flagRow(f)) : [div().text_size(12).text_color(t.muted).child('Every halt has a recorded reason.')]));
    const halts = model.halts.flatMap((g) => [div().text_size(12).text_color(t.muted).child(`${g.cause} (${g.rows.length})`), ...g.rows.map((r) => this.haltRow(r))]);
    root.child(this.section('halts', `Halts (${model.halts.reduce((n, g) => n + g.rows.length, 0)})`,
      halts.length ? halts : [div().text_size(12).text_color(t.muted).child('Nothing is stuck.')]));
    root.child(this.section('seats', `Seats (${model.seats.filter((s) => s.presence === 'live').length} live)`,
      model.seats.length ? model.seats.map((s) => this.seatRow(s)) : [div().text_size(12).text_color(t.muted).child('No seats.')]));
    const c = model.capacity;
    const runners = c.runners.map((r) => div().id('runner-' + r.host).text_size(12)
      .child(`${r.host}: ${r.inUse}/${r.slots} slots, ${r.browserInUse}/${r.browser} browser${r.unavailable ? ', unavailable' : ''}`));
    root.child(this.section('capacity', 'Test capacity', [
      this.slotRow('gateSlots', 'Gate', c.gate, c, cx),
      this.slotRow('browserSlots', 'Browser', c.browser, c, cx),
      div().text_size(11).text_color(t.muted).child(`short slots ${c.shortSlots} · runners first ${c.runnersFirst ? 'on' : 'off'}`),
      ...(runners.length ? runners : [div().text_size(12).text_color(t.muted).child('No runners registered.')]),
    ]));
    if (this.moveMessage) root.child(div().text_size(12).text_color(t.muted).child(this.moveMessage));
    return root;
  }
}
