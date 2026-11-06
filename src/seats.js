import { policyOn } from './policy-settings.js';
import {
  agentAt,
  agentById,
  agentModel,
  agentParent,
  withModel,
  listAgents,
} from './board-query.js';
/**
 * Seats (B3, H2, V1): who each registered agent is on the board, read from the agent table and the
 * metadata kept beside it: its model, its route, and from engine 48 the seat that created it, whether
 * the relay enrolled it, and its machine lineage. Verifier standing on a linked board (#579) is
 * decided here from that line of creators. board.js registers seats and re-exports the readers.
 */
import { COORDINATOR } from './config.js';
import {
  ENGINE_VERSION,
  VERIFIER_STANDING_ENGINE,
} from './machine.js';
import { Refused } from './refused.js';

/** The board's coordinator hold travels with its seats: one main checkout coordinates a linked board (#347). */
export { coordinatorHolder, takeCoordinator } from './coordinator-hold.js';

export { agentAt } from './board-query.js';

export { agentById } from './board-query.js';

export { agentModel } from './board-query.js';

export { withModel } from './board-query.js';

/** Save or clear a model label without changing the shared SQLite schema. */
export function saveAgentModel(board, id, model) {
  if (model === null || model === undefined) {
    board.db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run(`agent_model:${id}`);
    return;
  }
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
    .run(`agent_model:${id}`, model);
}

export { listAgents } from './board-query.js';

/**
 * The route an agent joined on; strong for the coordinator and for ids the board does not know.
 *
 * @param {any} board
 * @param {string} agentId
 * @returns {string}
 */
export function routeOf(board, agentId) {
  return board.db.prepare('SELECT agent_route FROM agent WHERE agent_id = ?').get(agentId)?.agent_route ?? 'strong';
}

/**
 * The id an engine-48 registration gives a new seat: the named one when it is the lane's form and
 * free, otherwise the lane's first free number from its count. Skipping taken numbers keeps a named
 * seat from colliding with the next unnamed one.
 *
 * @param {any} board
 * @param {string} lane
 * @param {number} total
 * @param {string | undefined} named
 * @returns {string}
 */
export function newSeatId(board, lane, total, named) {
  if (named === undefined) return firstFreeSeatId(board, lane, total);
  const number = typeof named === 'string' && named.startsWith(`${lane}-`) ? named.slice(lane.length + 1) : '';
  if (!/^[1-9][0-9]{0,8}$/.test(number) || Number(number) <= total || board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(named)) {
    throw new Refused('BAD_SEAT_ID', `a new ${lane} seat is named ${lane}-<n> above the lane's count and not yet taken; register again without a name`);
  }
  return named;
}

/**
 * The lane's first seat number above its count that no seat holds yet.
 *
 * @param {any} board
 * @param {string} lane
 * @param {number} total
 * @returns {string}
 */
function firstFreeSeatId(board, lane, total) {
  let n = total + 1;
  while (board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(`${lane}-${n}`)) n += 1;
  return `${lane}-${n}`;
}

/**
 * The seat that created this one, as its engine-48 registration recorded it: an agent id,
 * `machine` for a join no seat made, or null for a seat registered before engine 48.
 *
 * @param {any} board
 * @param {string} id
 * @returns {string | null}
 */
export function agentCreator(board, id) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_creator:${id}`)?.meta_value ?? null;
}

/**
 * Whether a relay replica enrolled this seat from its creator's receipt-bound registration (#579).
 *
 * @param {any} board
 * @param {string} id
 * @returns {boolean}
 */
export function seatEnrolled(board, id) {
  return Boolean(board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key = ?').get(`agent_enrolled:${id}`));
}

/**
 * The machine registration lineage a relay-enrolled seat descends from: the person-set coordinator
 * token of the machine that made its line (#579), or null when it was never recorded.
 *
 * @param {any} board
 * @param {string} id
 * @returns {string | null}
 */
export function seatLineage(board, id) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_lineage:${id}`)?.meta_value ?? null;
}

/**
 * The id the next registration in a lane gets when it names none, for a creator that must
 * predict it before sealing the move (the relay receipt names the target seat).
 *
 * @param {any} board
 * @param {string} lane
 * @returns {string}
 */
export function nextSeatId(board, lane) {
  const { total } = board.db.prepare('SELECT COUNT(*) AS total FROM agent WHERE agent_lane = ?').get(lane);
  return firstFreeSeatId(board, lane, total);
}

/**
 * Run board work under linked-board verifier standing (#579): a relay replica replaying an
 * engine-48 move, or a linked CLI previewing one. `root` says whether the acting coordinator's
 * relay credential was set up by the person. Unlinked boards never enter this, so who may verify
 * there is unchanged.
 *
 * @template T
 * @param {any} board
 * @param {{ root: boolean, person?: boolean, lineage?: string | null }} standing
 * @param {() => T} work
 * @returns {T}
 */
export function withVerifierStanding(board, standing, work) {
  const previous = board.verifierStanding;
  board.verifierStanding = { root: standing.root === true, person: standing.person === true,
    lineage: typeof standing.lineage === 'string' ? standing.lineage : null };
  try { return work(); }
  finally {
    if (previous === undefined) delete board.verifierStanding;
    else board.verifierStanding = previous;
  }
}

/**
 * Why this seat may not verify the builder's item on a linked board, or null when it may. The
 * seat's creators are walked up to the coordinator: the builder, a join no seat made (`machine`),
 * or a seat registered before engine 48 anywhere on the way means no standing. The coordinator
 * stands only on a credential the person set up.
 *
 * @param {any} board
 * @param {string} verifier
 * @param {string} builder
 * @param {number} itemId
 * @returns {Refused | null}
 */
export function standingProblem(board, verifier, builder, itemId) {
  const standing = board.verifierStanding;
  if (!standing || (board.executionEngineVersion ?? ENGINE_VERSION) < VERIFIER_STANDING_ENGINE) return null;
  // Read from ordered board state, so a replica replaying this verdict reaches the same answer.
  if (!policyOn(board, 'verifierStanding')) return null;
  const refuse = (why) => new Refused('VERIFIER_STANDING',
    `${verifier} cannot verify work built by ${builder} on this linked board: ${why}; ask the coordinator to make an independent verifier from the main checkout: pullboard worktree <lane> --model "<model name>"`);
  if (builder === COORDINATOR) {
    // The person stands above every seat; otherwise only a seat from another machine's line may.
    if (standing.person) return null;
    const refuseOwn = (why) => new Refused('VERIFIER_STANDING', `${verifier} cannot verify work the coordinator built on this linked board: ${why}; a seat from another machine's registration lineage, or the person, verifies it`);
    const built = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`item_lineage:${itemId}`)?.meta_value ?? null;
    const lineage = seatLineage(board, verifier);
    if (!built || !lineage) return refuseOwn('the machine lineage of the build or of this seat was not recorded');
    if (built === lineage) return refuseOwn('this seat shares the building machine\'s registration lineage');
    for (let seat = verifier, seen = new Set(); seat !== COORDINATOR; seat = agentCreator(board, seat)) {
      if (seen.has(seat) || !seatEnrolled(board, seat)) return refuseOwn(`${seat} was not enrolled through the relay`);
      seen.add(seat);
    }
    return null;
  }
  const seen = new Set();
  for (let seat = verifier; ;) {
    if (seat === COORDINATOR) {
      return standing.root || seat !== verifier ? null
        : refuse('the coordinator credential was not set up by the person; run pullboard relay on in the main checkout once');
    }
    if (seen.has(seat)) return refuse('its line of creating seats loops');
    seen.add(seat);
    const creator = agentCreator(board, seat);
    if (creator === 'machine') return refuse(`${seat} joined without a creating seat`);
    if (creator === builder) return refuse(`${seat} was created by the builder`);
    if (creator === null || !seatEnrolled(board, seat)) {
      return refuse(`${seat} was not enrolled by its creating seat through the relay`);
    }
    seat = creator;
  }
}

export { agentParent } from './board-query.js';

/** A root session is its own parent, even while its missing parent is displayed as unknown. */
export function effectiveAgentParent(board, id) {
  return agentParent(board, id)
    ?? board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_session:${id}`)?.meta_value
    ?? `seat:${id}`;
}

/** Persist the joined session independently of its parent, so a root and its children share independence. */
export function saveAgentSession(board, id, digest) {
  const key = `agent_session:${id}`;
  const previous = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(key)?.meta_value;
  if (previous && previous !== digest) throw new Refused('PARENT_SESSION_CHANGED', 'this seat already belongs to another session; create a fresh worktree and join there');
  if (!previous) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(key, digest);
}

/** Persist a parent once, preserving author independence across later joins. */
export function saveAgentParent(board, id, digest) {
  const previous = agentParent(board, id);
  if (previous && previous !== digest) throw new Refused('PARENT_SESSION_CHANGED', 'this seat already belongs to another parent session; create a fresh worktree and join there');
  const own = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_session:${id}`)?.meta_value;
  if (!previous && own && own !== digest) throw new Refused('PARENT_SESSION_CHANGED', 'this seat already joined as its own parent session; create a fresh worktree to declare another parent');
  if (!previous) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`agent_parent_session:${id}`, digest);
}
