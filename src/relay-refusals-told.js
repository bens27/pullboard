/** Remember which kept relay refusals relay on has told the person, so it tells each once [H21,B26]. */
import { repoInfo } from './git.js';
import { relayFiles } from './local-state.js';
import { readRelayLink } from './relay-link-read.js';
import { locked } from './relay-lock.js';
import { saveLink } from './relay.js';
import {
  migrateRefusals,
  sameRefusal,
  untoldRefusals,
} from './relay-refusals.js';

function linkFile(root) {
  return relayFiles(repoInfo(root).commonDir).link;
}

/** Only the refusals of `refusals` this board's relay on has not told yet; reads the cursor and writes nothing. */
export function untoldOf(root, refusals) {
  if (!refusals?.length) return [];
  const told = readRelayLink(linkFile(root))?.outboxRefusalsTold;
  const cursor = Number.isSafeInteger(told) ? told : 0;
  return refusals.filter(kept => kept.seq > cursor).sort((a, b) => a.seq - b.seq);
}

/**
 * Move the told cursor past the refusals that were printed. Why a walk, not a jump: an older process may have
 * appended or sliced unnumbered entries since the print, shifting numbers; the walk stops at the first entry that
 * differs from what was printed, so a refusal is shown again rather than lost. Best-effort after the output: a
 * failure leaves the cursor and the command's result alone.
 */
export async function advanceTold(root, printed, io) {
  if (!printed?.length) return;
  try {
    const file = linkFile(root);
    await locked(file, async () => {
      const state = readRelayLink(file);
      if (!state?.outboxRefusals?.length) return;
      const migrated = migrateRefusals(state);
      const before = Number.isSafeInteger(state.outboxRefusalsTold) ? state.outboxRefusalsTold : 0;
      let cursor = before;
      for (const kept of untoldRefusals(state)) {
        if (!printed.some(said => sameRefusal(said, kept))) break;
        cursor = kept.seq;
      }
      if (cursor !== before) state.outboxRefusalsTold = cursor;
      if (cursor !== before || migrated) saveLink(file, state);
    }, io);
  } catch (error) { io.err?.(`pullboard: the relay refusals above will be shown again on the next relay on: ${error?.message ?? error}`); }
}
