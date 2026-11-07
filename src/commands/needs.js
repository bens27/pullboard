/** The pullboard needs command: one list of what waits on the person, shared by the view and the Herdr panels [B26,N26]. */
import * as store from '../board.js';
import { withBoardRead } from '../cli-board-read.js';
import {
  context,
  coordinatorDecisionSections,
} from '../cli.js';
import { needsList } from '../needs-steps.js';
import { pendingRowApply } from '../resume.js';
import { resumeNeeds } from '../resume-needs.js';
import { staleRowDecisions } from '../row-decision-state.js';
import { mainRoot } from './ask.js';

/** Run `pullboard needs` and print the list; it reads the board and changes nothing. */
export async function run(io) {
  const ctx = context(io);
  const root = mainRoot(ctx.info);
  const needs = await withBoardRead(ctx, (board) => {
    const sections = coordinatorDecisionSections(board, ctx);
    const decisions = store.rowDecisions(board);
    return needsList({ root, needs: resumeNeeds(ctx.info.root, { board, config: ctx.config }).needs,
      pendingApply: pendingRowApply(decisions, staleRowDecisions(decisions, ctx.info.root, ctx.config)),
      openDecisions: sections.openDecisions, personQuestions: sections.personQuestions, asks: store.asks(board) });
  });
  io.result?.({ root, needs });
  if (!needs.length) io.say('nothing needs you');
  for (const need of needs) {
    const next = need.steps.find(entry => entry.n === need.next);
    io.say(`${need.id}  ${need.title}${need.from ? `  (from ${need.from})` : ''}`);
    if (next) io.say(`  ${need.steps.length > 1 ? `step ${next.n}/${need.steps.length}: ` : ''}${next.command}${next.personOnly ? '' : '  (an agent may run this)'}`);
    else if (need.why) io.say(`  ${need.why}`);
  }
  return 0;
}
