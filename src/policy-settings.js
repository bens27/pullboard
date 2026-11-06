/** Workflow policy is the person's layer: each rule is a board setting, at its default until the board changes it. */
import { Refused } from './refused.js';

/**
 * The board policies this build can enforce, each read from the board's ordered line settings so
 * every replica that applies the same history makes the same decision on replay.
 */
export const POLICY_SETTINGS = Object.freeze({
  verifierStanding: 'on a linked board, a verifier needs relay standing apart from the builder\'s machine lineage (VERIFIER_STANDING)',
  selfVerify: 'an earlier claimer, or a seat of the builder\'s agent session, never verifies the item; the building seat never does whatever the policy (SELF_VERIFY, SELF_SESSION_VERIFY)',
  mainVerifier: 'a verdict from the main checkout needs --as coordinator (MAIN_IS_COORDINATOR)',
  personChannel: 'person-only moves come only from the person\'s own terminal or view; off lets the coordinator record one for the person with --for-person --note (B26_PERSON_CHANNEL)',
  personTouchId: 'on a Mac, a spec, check or sentinel decision typed into an agent\'s terminal proceeds once the person confirms it with Touch ID, recorded with channel touchid (B26_PERSON_CHANNEL)',
  personPhoneOnly: 'on a linked board, a person move goes only from the paired phone; off lets the person\'s own terminal or view on a Mac signed in with pullboard relay person on send it, after one Touch ID fingerprint for that move (HUMAN_REQUIRED)',
});

/** The person's chosen defaults: an independent verifier stays on; the other policies start off. */
export const POLICY_DEFAULTS = Object.freeze({ verifierStanding: false, selfVerify: true, mainVerifier: false, personChannel: false, personTouchId: false, personPhoneOnly: false });

/** The board_meta key a policy's line setting is stored under. */
export function policyKey(name) { return `policy.${name}`; }

/**
 * Whether the board enforces this policy. Read straight from board_meta, without the line-settings
 * module, because the verify checks that call it load before board operations do.
 */
export function policyOn(board, name) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`line_setting:${policyKey(name)}`);
  if (!row) return POLICY_DEFAULTS[name] === true;
  try { return JSON.parse(row.meta_value) === true; } catch { return POLICY_DEFAULTS[name] === true; }
}

/** The channel a coordinator records a person move under when it acts on the person's say-so. */
export const FOR_PERSON_CHANNEL = 'for-person';

/** The principal a for-person record names, so it never reads as the person's own decision. */
export const FOR_PERSON_BY = 'coordinator-for-person';

/** The channel a person move carries when Touch ID confirmed it in an agent's terminal (src/touch-id.js). */
export const TOUCH_ID_CHANNEL = 'touchid';

/** Whether a channel is the person's own: their terminal, the view, or Touch ID while the board turns policy.personTouchId on. */
export function personOwnChannel(board, channel) {
  return ['terminal', 'view'].includes(channel) || channel === TOUCH_ID_CHANNEL && policyOn(board, 'personTouchId');
}

/** Whether a person move may arrive on this channel: the person's own channels, or the coordinator's for-person record while the policy is off. */
export function personChannelAccepted(board, channel) {
  return personOwnChannel(board, channel) || channel === FOR_PERSON_CHANNEL && !policyOn(board, 'personChannel');
}

/** The person moves a coordinator may record for the person: row decisions and answers, check acceptance, sentinel decisions. */
export const FOR_PERSON_OPERATIONS = Object.freeze(['recordRowDecisions', 'acceptCheck', 'decideSentinel']);

/** True for a move args object the coordinator recorded on the person's behalf. */
export function forPersonMove(move) {
  return FOR_PERSON_OPERATIONS.includes(move?.operation) && Array.isArray(move?.args) && move.args.some(arg => arg && typeof arg === 'object' && arg.channel === FOR_PERSON_CHANNEL);
}

/**
 * Read --for-person and its --note, or null when the flag is absent. Only the coordinator in the main
 * checkout may use it, only while policy.personChannel is off, and only with the person's words as the note,
 * so the record says who recorded it and on what instruction.
 *
 * @param {{ info: { isMain: boolean } }} ctx
 * @param {any} board
 * @param {string} actor - the caller's seat id
 * @param {Record<string, any>} values
 * @param {{ signed?: boolean }} [options] - signed: the board takes person moves only as passkey-confirmed requests
 * @returns {{ note: string, by: string, channel: string } | null}
 */
export function forPersonRequest(ctx, board, actor, values, { signed = false } = {}) {
  if (!values?.['for-person']) return null;
  if (!ctx.info.isMain || actor !== 'coordinator') throw new Refused('FOR_PERSON_COORDINATOR', 'only the coordinator, from the main checkout, records a person move on the person\'s behalf');
  if (signed) throw new Refused('PERSON_SIGNED', 'signed person moves are on for this board, so the person confirms this move with their passkey; --for-person cannot stand in for it');
  if (policyOn(board, 'personChannel')) throw new Refused('B26_PERSON_CHANNEL', 'this board turned policy.personChannel on, so the person makes this move from their own terminal or pullboard view');
  const note = typeof values.note === 'string' ? values.note.trim() : '';
  if (!note || /[\r\n]/u.test(note)) throw new Refused('FOR_PERSON_NOTE', 'say what the person told you, on one line: --for-person --note "<what the person said>"');
  return { note, by: FOR_PERSON_BY, channel: FOR_PERSON_CHANNEL };
}
