/** Person calls that read only files and item rows, so status can list them without the board writer [B26,S5,C7]. */
import { existsSync } from 'node:fs';
import {
  rowEvidence,
  rowStage,
} from './evidence.js';
import { repoInfo } from './git.js';
import { relayLinkFile } from './local-state.js';
import { Refused } from './refused.js';
import {
  readSignoffs,
  standings,
  unmetRows,
} from './spec.js';

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
