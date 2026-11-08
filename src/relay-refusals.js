/** Kept relay replay refusals: append-only, numbered per board, pruned by age and count when one is recorded [H21,B26]. */

/** How long a kept refusal stays; the relay's own receipts keep the full history. */
export const REFUSAL_DAYS = 30;
/** How many refusals a link keeps at most. */
export const REFUSAL_CAP = 200;
const DAY = 24 * 60 * 60 * 1000;

/** The highest refusal number this link has handed out, from its counter or its entries. */
function highestSeq(state) {
  let high = Number.isSafeInteger(state?.outboxRefusalSeq) ? state.outboxRefusalSeq : 0;
  for (const kept of state?.outboxRefusals ?? []) if (Number.isSafeInteger(kept?.seq) && kept.seq > high) high = kept.seq;
  return high;
}

/**
 * Copies of the kept refusals, each with a number. Why pure: status reads must write nothing, and an entry saved
 * before numbering, or appended by an older process, gets the same next number on every read until a write keeps it.
 */
export function numberRefusals(state) {
  let next = highestSeq(state);
  return (state?.outboxRefusals ?? []).map(kept => (Number.isSafeInteger(kept?.seq) ? structuredClone(kept) : { ...structuredClone(kept), seq: ++next }));
}

/** Number the kept refusals in place, for a path that is about to save the link anyway. */
export function migrateRefusals(state) {
  if (!state?.outboxRefusals?.length) return false;
  const numbered = numberRefusals(state);
  const changed = numbered.some((kept, index) => kept.seq !== state.outboxRefusals[index].seq);
  state.outboxRefusals = numbered;
  const high = highestSeq(state);
  if (state.outboxRefusalSeq !== high) state.outboxRefusalSeq = high;
  return changed;
}

/** When a kept refusal was recorded: its own stamp, or the time its move was queued for one saved before stamps. */
function recordedAt(kept) {
  const at = Date.parse(kept?.at ?? kept?.queuedAt ?? '');
  return Number.isFinite(at) ? at : null;
}

/** Append one refusal with the next number and drop those past the age limit and the count cap. */
export function recordRefusal(state, kept, now = Date.now()) {
  migrateRefusals(state);
  const seq = highestSeq(state) + 1;
  const stamped = { ...kept, seq, at: new Date(now).toISOString() };
  const fresh = [...(state.outboxRefusals ?? []), stamped].filter(entry => {
    const at = recordedAt(entry);
    return at === null || now - at <= REFUSAL_DAYS * DAY;
  });
  state.outboxRefusals = fresh.slice(-REFUSAL_CAP);
  state.outboxRefusalSeq = seq;
  return stamped;
}

/** The numbered refusals above this link's told cursor, oldest first. */
export function untoldRefusals(state) {
  const told = Number.isSafeInteger(state?.outboxRefusalsTold) ? state.outboxRefusalsTold : 0;
  return numberRefusals(state).filter(kept => kept.seq > told).sort((a, b) => a.seq - b.seq);
}

/** Whether a saved refusal is the one printed: number and content alike, so a renumbered entry is shown again. */
export function sameRefusal(a, b) {
  return a.seq === b.seq && a.move === b.move && a.queuedAt === b.queuedAt && a.code === b.code && a.message === b.message;
}
