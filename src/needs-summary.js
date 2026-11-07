/** Status obligations without loading the dashboard projection [N26,A9]. */
import * as store from './board-query.js';
import { repoInfo } from './git.js';
import { projectRowDecisions } from './row-decisions.js';
import { loadSpec } from './spec.js';
import { loadDoctrine } from './doctrine.js';
import { rigorDraftNeeds } from './rigor-notices.js';
import { personBlockWords } from './blocks.js';
import { displayAgentName } from './agent-names.js';
import {
  projectSpecApprovals,
  specApprovalState,
} from './spec-approval.js';
import {
  sentinelDraftNeeds,
  sentinels,
} from './board-query.js';
import { relayCanaryNeeds } from './relay-canary-needs.js';
import {
  relayLinkedQuietly,
  signoffsDue,
} from './signoffs-due.js';

/**
 * Keep status obligations; reuse its same-call seat rows, otherwise read them freshly. Person
 * verifies are computed only on a linked board, by the caller's `personVerifies` from
 * person-calls.js, which loads the board writer; an offline status never pays for it [C7].
 */
export function personNeedsSummary(root, { board, config, agents, personVerifies }) {
  const spec = loadSpec(root, config);
  const items = store.listItems(board, { all: true });
  const rows = projectRowDecisions(store.rowDecisions(board), { root, spec: spec.rows, practice: loadDoctrine(root, config).rows });
  const projected = projectSpecApprovals({ ...rows,
    decisions: store.openDecisions(board, store.PERSON), holds: store.laneHolds(board),
    agents: (agents ?? store.listAgents(board)).map(agent => ({ ...agent, displayName: displayAgentName(agent, config.agents.names) })),
    rigorDrafts: rigorDraftNeeds(rows, store.rowDrafts(board), store.rowDecisions(board)), sentinelDrafts: sentinelDraftNeeds(sentinels(board)), blocks: recentBlocks(repoInfo(root).commonDir, board),
    personVerifies: relayLinkedQuietly(root) ? personVerifies(board, items, { linked: true }) : [], signoffsDue: signoffsDue(root, spec.rows, items),
  }, specApprovalState(root, { board, config, spec }));
  const relayHealthAlerts = relayCanaryNeeds(root);
  return { ...projected, relayHealthAlerts, needs: [...projected.needs, ...relayHealthAlerts] };
}

/** The person's blocks from the last day, by the board's clock, for Needs you [C6]. */
export function recentBlocks(commonDir, board) {
  return personBlockWords(commonDir, (board?.clock ?? store.systemClock).now());
}
