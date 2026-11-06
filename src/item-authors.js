/** Review independence follows every claim and submit author, never just the latest owner [V1,B3]. */
import { ENGINE_VERSION } from './machine.js';
import { HISTORICAL_AUTHORS_ENGINE } from './historical-authors-engine.js';
import { Refused } from './refused.js';
import { PARENT_SESSION_ENGINE } from './parent-session-engine.js';
import { effectiveAgentParent } from './seats.js';
import { standingProblem } from './seats.js';
import { policyOn } from './policy-settings.js';

/** Read one item's indexed author history; older ordered moves retain their original current-builder rule. */
export function itemAuthors(board, item) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < HISTORICAL_AUTHORS_ENGINE) return [item.item_built_by].filter(Boolean);
  const authors = new Set([item.item_built_by, item.item_owner].filter(Boolean));
  for (const event of board.db.prepare("SELECT DISTINCT event_by FROM event WHERE item_id = ? AND event_kind IN ('claim', 'submit')").all(item.item_id)) {
    if (typeof event.event_by === 'string' && event.event_by) authors.add(event.event_by);
  }
  return [...authors];
}

/** Compare immutable author and parent identities without borrowing the current sender’s verifier credential. */
function authorIdentityProblem(board, item, reviewer, authors) {
  // The board schema itself refuses a verdict by the seat that built the item, so that one rule holds whatever the policy;
  // earlier claimers and seats of the builder's parent session are refused only while policy.selfVerify is on.
  if (!policyOn(board, 'selfVerify')) {
    return reviewer === item.item_built_by ? new Refused('SELF_VERIFY', 'the seat that built an item never verifies it; verify from another seat') : null;
  }
  if (authors.includes(reviewer)) return new Refused('SELF_VERIFY', 'the builder never verifies its own work; another agent must');
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= PARENT_SESSION_ENGINE) {
    const parent = effectiveAgentParent(board, reviewer);
    if (authors.some(author => effectiveAgentParent(board, author) === parent)) {
      return new Refused('SELF_SESSION_VERIFY', `this seat shares a parent session with an author of #${item.item_id}; ask a seat under another parent session to verify it`);
    }
  }
  return null;
}

/** A retained native verdict keeps its original authority but may not cover work by a newly related author. */
export function retainedVerifierIdentityProblem(board, item, reviewer) {
  return authorIdentityProblem(board, item, reviewer, itemAuthors(board, item));
}

/** Apply full author identity and current linked standing to every fresh review and queue selection. */
export function itemAuthorProblem(board, item, reviewer) {
  const authors = itemAuthors(board, item);
  const identity = authorIdentityProblem(board, item, reviewer, authors);
  if (identity) return identity;
  return (authors.length ? authors : [item.item_built_by])
    .map(author => standingProblem(board, reviewer, author, item.item_id)).find(Boolean) ?? null;
}
