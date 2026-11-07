/** The pullboard needs command: one list of what waits on the person, shared by the view and the Herdr panels [B26,N26]. */
import * as store from '../board.js';
import { withBoardRead } from '../cli-board-read.js';
import {
  context,
  coordinatorDecisionSections,
} from '../cli.js';
import { needsList } from '../needs-steps.js';
import { pendingRowApply } from '../resume.js';
import { readRawRecords } from '../signature.js';
import { resumeNeeds } from '../resume-needs.js';
import { staleRowDecisions } from '../row-decision-state.js';
import { loadConfig } from '../config.js';
import { mainRoot } from './ask.js';

/** Who signed this repo's last sign-off, to offer as the next signer; none when the ledger is missing or unreadable. */
function lastSigner(root) {
  try {
    const by = readRawRecords(root).at(-1)?.by;
    return typeof by === 'string' ? by : '';
  } catch {
    return '';
  }
}

/** Run `pullboard needs` and print the list; it reads the board and changes nothing. */
export async function run(io) {
  const ctx = context(io);
  const root = mainRoot(ctx.info);
  // Every step runs in the main checkout, so its rows and config decide what to offer;
  // a lagging worktree's SPEC.md would offer stale or unknown ids.
  const config = ctx.info.isMain ? ctx.config : loadConfig(root);
  const needs = await withBoardRead(ctx, (board) => {
    const sections = coordinatorDecisionSections(board, ctx);
    const decisions = store.rowDecisions(board);
    return needsList({ root, needs: resumeNeeds(root, { board, config }).needs,
      pendingApply: pendingRowApply(decisions, staleRowDecisions(decisions, root, config)),
      openDecisions: sections.openDecisions, personQuestions: sections.personQuestions, asks: store.asks(board),
      signer: lastSigner(root) });
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
