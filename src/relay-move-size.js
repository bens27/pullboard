/** Measure a move against the relay's request body limit before it is queued or sent [A6,B26,H16]. */
import { Refused } from './refused.js';
import { RELAY_BODY_BYTES } from './relay-limits.js';

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

export { RELAY_BODY_BYTES };
