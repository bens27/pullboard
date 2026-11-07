/** The pullboard ask command: a seat files steps for the person, who runs them at their own pace [B26]. */
import {
  dirname,
  resolve,
} from 'node:path';
import { Refused } from '../refused.js';
import { parseAskStep } from '../asks.js';
import {
  actOn,
  ordered,
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

/** Read an ask id as the number pullboard needs shows, with or without its ask: prefix. */
function askId(value) {
  const text = String(value ?? '').replace(/^ask:/u, '');
  if (!/^[1-9]\d*$/u.test(text)) throw new Refused('BAD_ASK', 'name an ask by its number from pullboard needs');
  return Number(text);
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
      row = await ordered(ctx, board, 'recordAsk', [{ agentId: me.id, action: 'done', id: askId(second), step: stepNumber(values), note: values.note }]);
    } else if (first === 'drop') {
      row = await ordered(ctx, board, 'recordAsk', [{ agentId: me.id, action: 'drop', id: askId(second), reason: values.reason }]);
    } else {
      const title = [first, second, ...rest].filter(word => word !== undefined).join(' ');
      const steps = [values.step ?? []].flat().map(parseAskStep);
      const cwd = values.cwd ? resolve(values.cwd) : mainRoot(ctx.info);
      row = await ordered(ctx, board, 'recordAsk', [{ agentId: me.id, action: 'file',
        ask: { title, why: values.why ?? '', cwd, personOnly: values['person-only'] === true, steps } }]);
    }
    io.result?.({ ask: row });
    sayAsk(io, row);
    return 0;
  });
}
