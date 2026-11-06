/** Finished work only the person can carry further: a verdict no seat may give, a row ready to sign [B26,V1,S5]. */
import { existsSync } from 'node:fs';
import { COORDINATOR } from './config.js';
import { rowEvidence, rowStage } from './evidence.js';
import { repoInfo } from './git.js';
import { itemAuthors, itemAuthorProblem } from './item-authors.js';
import { relayLinkFile } from './local-state.js';
import { Refused } from './refused.js';
import { listAgents } from './board-query.js';
import { withVerifierStanding } from './seats.js';
import { readSignoffs, standings, unmetRows } from './spec.js';

/**
 * Submitted items whose verdict only the person can give. On a linked board with
 * policy.verifierStanding on, the relay refuses
 * VERIFIER_STANDING to every seat of the building machine's lineage for work the coordinator
 * built, so a fresh seat made here cannot help; the item waits for the person or another
 * machine's seat. Each seat is judged by the same author and standing rule `next --verify`
 * previews, so this list never names an item some current seat could take.
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

/** Whether this repo is linked to the relay, read without loading the relay client or failing on its file. */
export function relayLinkedQuietly(root) {
  return existsSync(relayLinkFile(repoInfo(root).commonDir));
}

/**
 * Approved spec rows with no current sign-off whose cited items are all verified, so only the
 * person's sign-off is left. Readiness is `pullboard spec unmet`'s own stage; the row-decision
 * receipts that share the sign-off file approve a row and never sign it.
 *
 * @param {string} root
 * @param {any[]} rows Parsed spec rows.
 * @param {any[]} items Raw item rows, as listItems reads them.
 * @returns {{ id: string, text: string, items: number[] }[]}
 */
export function signoffsDue(root, rows, items) {
  let signoffs;
  try { signoffs = readSignoffs(root).filter(record => record.type !== 'row-decision'); }
  catch (error) {
    // An unreadable or unverifiable sign-off file is spec check's to report; it names no row ready.
    if (error instanceof Refused) return [];
    throw error;
  }
  const by = standings(rows, signoffs);
  return unmetRows(rows, signoffs).flatMap(row => {
    // Only item state decides readiness, so the cited test files are never read here.
    const evidence = rowEvidence(root, row.id, { items, testFiles: [] });
    return rowStage(by.get(row.id), evidence) === 'verified and ready to sign'
      ? [{ id: row.id, text: row.text, items: evidence.verified.map(item => item.id) }] : [];
  });
}
