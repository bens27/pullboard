/** The pullboard ask command: a seat files steps for the person, who runs them at their own pace [B26]. */
import { randomBytes } from 'node:crypto';
import {
  dirname,
  resolve,
} from 'node:path';
import { Refused } from '../refused.js';
import { requirePersonChannel } from '../person.js';
import { requireSignedPerson } from '../person-signing-cli.js';
import {
  ASK_ID,
  parseAskStep,
} from '../asks.js';
import {
  actOn,
  ordered,
  personMode,
} from '../cli.js';

/** The main checkout, where the person's own terminal and the panels run commands by default. */
export function mainRoot(info) {
  return info.isMain ? info.root : dirname(info.commonDir);
}

/** Read `--step` as a whole positive step number for ask done. */
function stepNumber(values) {
  const raw = [values.step ?? []].flat();
  if (!raw.length) return undefined;
  if (raw.length > 1 || !/^[1-9]\d*$/u.test(raw[0])) throw new Refused('BAD_ASK', 'name one step: pullboard ask done <id> --step <n>');
  return Number(raw[0]);
}

/** Read an ask id as pullboard needs shows it, with or without its ask: prefix. */
function askId(value) {
  const text = String(value ?? '').replace(/^ask:/u, '');
  if (!ASK_ID.test(text)) throw new Refused('BAD_ASK', 'name an ask by its id from pullboard needs, e.g. ask:3f9a0c12');
  return text;
}

/** Say one ask on one line with its next step. */
function sayAsk(io, row) {
  const next = row.steps.find(step => !step.done);
  io.say(`ask ${row.id} ${row.status}: ${row.title}${next ? `\n  next step ${next.n}: ${next.label} — ${next.command}` : ''}`);
}

/** Run `pullboard ask`, `pullboard ask done` or `pullboard ask drop`. */
export async function run(io, { first, second, rest, values }) {
  return actOn(io, async (ctx, board, me) => {
    let row;
    if (first === 'done') {
      // A person-only ask closes only as the person: the main checkout with --as person, or the view [B26].
      const asPerson = io.personChannel === 'view' || personMode(ctx, me, values);
      if (asPerson) {
        const confirmed = await requireSignedPerson(ctx, board, me, null);
        if (confirmed !== null) return confirmed;
        requirePersonChannel(io.personChannel);
      }
      row = await ordered(ctx, board, 'recordAsk', [{ agentId: me.id, action: 'done', id: askId(second), step: stepNumber(values), note: values.note,
        asPerson, channel: io.personChannel ?? 'terminal' }]);
    } else if (first === 'drop') {
      row = await ordered(ctx, board, 'recordAsk', [{ agentId: me.id, action: 'drop', id: askId(second), reason: values.reason }]);
    } else {
      const title = [first, second, ...rest].filter(word => word !== undefined).join(' ');
      const steps = [values.step ?? []].flat().map(parseAskStep);
      const cwd = values.cwd ? resolve(values.cwd) : mainRoot(ctx.info);
      row = await ordered(ctx, board, 'recordAsk', [{ agentId: me.id, action: 'file', id: randomBytes(4).toString('hex'),
        ask: { title, why: values.why ?? '', cwd, personOnly: values['person-only'] === true, steps } }]);
    }
    io.result?.({ ask: row });
    sayAsk(io, row);
    return 0;
  });
}
