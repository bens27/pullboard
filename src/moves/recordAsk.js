/** Filing, finishing and dropping a person ask is one authenticated move [B26,H16]. */
import { ASK_ENGINE } from '../ask-engine.js';

/** Earlier engines cannot hold asks. */
function minimumEngine() { return ASK_ENGINE; }

/** Bind the ask record to the joined seat that files or closes it. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: 'recordAsk', engine: ASK_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    BAD_ASK: 'file it as pullboard ask "<title>" --step "<label>::<command>"; see pullboard help ask',
    NO_ASK: 'list the open asks with pullboard needs',
    ASK_CLOSED: 'this ask is already finished or dropped; read pullboard needs for the open ones',
    ASK_QUOTED_PLACEHOLDER: 'write each {key} as a bare word outside quotes, with no " ` \\ or $( in that step, e.g. --note {note}',
    ASK_NOT_FILER: 'only the seat that filed the ask or the coordinator drops it; shout the coordinator',
  }) });
