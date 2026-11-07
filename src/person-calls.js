/** Finished work only the person can carry further: a verdict no seat may give, a row ready to sign [B26,V1,S5]. */
import { COORDINATOR } from './config.js';
import {
  itemAuthors,
  itemAuthorProblem,
} from './item-authors.js';
import { listAgents } from './board-query.js';
import { withVerifierStanding } from './seats.js';

export {
  relayLinkedQuietly,
  signoffsDue,
} from './signoffs-due.js';

/**
 * Submitted items whose verdict only the person can give. On a linked board with
 * policy.verifierStanding on, the relay refuses VERIFIER_STANDING to every seat of the building
 * machine's lineage for work the coordinator built, so a fresh seat made here cannot help; the
 * item waits for the person or another machine's seat. With the policy off, only the author
 * rule can refuse every seat. Each seat is judged by the same author and standing rule
 * `next --verify` previews, so this list never names an item some current seat could take.
 *
 * @param {any} board
 * @param {any[]} items Raw item rows, as listItems reads them.
 * @param {{ linked: boolean }} options Whether this repo is linked to the relay.
 * @returns {{ id: number, title: string, commit: string | null, at: string }[]}
 */
export function personVerifies(board, items, { linked }) {
  if (!linked) return [];
  const seats = listAgents(board).map(agent => agent.agent_id);
  return withVerifierStanding(board, { root: true }, () => items
    .filter(item => item.item_status === 'submitted' && itemAuthors(board, item).includes(COORDINATOR)
      && seats.every(seat => itemAuthorProblem(board, item, seat)))
    .map(item => ({ id: item.item_id, title: item.item_title, commit: item.item_commit ?? null, at: item.item_updated_at })));
}
