/** Measure a move against the relay's request body limit before it is queued or sent [A6,B26,H16]. */
import { Refused } from './refused.js';
import { RELAY_BODY_BYTES } from './relay-limits.js';
import { presentationDigest } from './relay-presentation.js';

/** Seal version byte, nonce and authentication tag around each plaintext move (seal.js). */
const SEAL_OVERHEAD_BYTES = 1 + 12 + 16;
/** The POST wrapper at the largest sequence, so the estimate never depends on where the move lands. */
const WRAPPER_BYTES = Buffer.byteLength(JSON.stringify({ sequence: Number.MAX_SAFE_INTEGER, sealed: '' }));
/** Room for a seat registration receipt sent beside a join's sealed move. */
const REGISTRATION_SLACK_BYTES = 1024;

/** The largest request body this move can make once sealed and base64url-encoded. */
export function moveBodyBytes(move) {
  const sealed = Buffer.byteLength(JSON.stringify(move)) + SEAL_OVERHEAD_BYTES;
  return Math.ceil(sealed * 4 / 3) + WRAPPER_BYTES + REGISTRATION_SLACK_BYTES;
}

/** The exact body the relay client posts for one sealed pending move. */
export function pendingBodyBytes(pending) {
  return Buffer.byteLength(JSON.stringify({ sequence: pending.sequence, sealed: pending.sealed,
    ...(pending.registration ? { registration: pending.registration } : {}) }));
}

/**
 * Refuse a move the relay could never take, before it is queued.
 * Why: the relay's 400 is not transient, so a queued move over the limit would block every later move behind it.
 */
export function refuseOversizedMove(move, name = move.operation) {
  const bytes = moveBodyBytes(move);
  if (bytes <= RELAY_BODY_BYTES) return;
  throw new Refused('RELAY_MOVE_TOO_LARGE', `${name} would send about ${bytes} bytes, over the relay's ${RELAY_BODY_BYTES}-byte limit, so it was not queued; run it again with less text or fewer entries`);
}

/**
 * Seal the next mirrored local record within the relay's body limit, keeping a pending one that already fits.
 * Why: the relay's 400 for an oversized body never clears, so posting one would stop migration on every retry.
 * The presentation may be dropped because a later snapshot republishes it, and an older client's oversized pending
 * record can be resealed at its sequence because the relay never took it.
 */
export async function mirrorPending(state, event, present, seal) {
  if (state.pending && pendingBodyBytes(state.pending) <= RELAY_BODY_BYTES) return state.pending;
  const sequence = state.sequence + 1;
  const current = present();
  // Only a projection ending at this local record belongs to its relay position.
  const presentation = current.state.events[0]?.event_id === event.event_id ? current : undefined;
  let bytes = 0;
  for (const shown of presentation ? [presentation, undefined] : [undefined]) {
    const pending = { localEvent: event.event_id, sequence, needsPresentation: Boolean(state.needsPresentation || !shown),
      ...(shown ? { presentationDigest: presentationDigest(shown) } : {}), sealed: await seal({ event, presentation: shown }, sequence) };
    bytes = pendingBodyBytes(pending);
    if (bytes <= RELAY_BODY_BYTES) return pending;
  }
  throw new Refused('RELAY_MOVE_TOO_LARGE', `local event ${event.event_id} would send ${bytes} bytes, over the relay's ${RELAY_BODY_BYTES}-byte limit, so this older mirror link cannot send it; run pullboard relay off then pullboard relay on to re-link this board from a fresh snapshot`,
    'run pullboard relay off, then pullboard relay on');
}

export { RELAY_BODY_BYTES };
