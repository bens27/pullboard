/** Preload that makes the shipped view port look held, so no test binds or reaches the person's real port [N26,C7]. */
import net from 'node:net';
import { DEFAULT_VIEW_PORT } from '../src/view-port.js';

// The sandboxed stand-in that answers in place of whatever holds the shipped port.
const standIn = Number(process.env.PULLBOARD_TEST_HELD_VIEW_PORT);

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function heldDefaultListen(...args) {
  const first = args[0];
  const port = typeof first === 'object' && first !== null ? first.port : first;
  if (port === undefined || Number(port) !== DEFAULT_VIEW_PORT) return listen.apply(this, args);
  const error = Object.assign(new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${DEFAULT_VIEW_PORT}`),
    { code: 'EADDRINUSE', errno: -48, syscall: 'listen', port: DEFAULT_VIEW_PORT });
  process.nextTick(() => this.emit('error', error));
  return this;
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function heldDefaultConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' && first !== null ? first : null;
  const port = options ? options.port : first;
  if (port === undefined || Number(port) !== DEFAULT_VIEW_PORT) return connect.apply(this, args);
  if (!(Number.isInteger(standIn) && standIn > 0)) {
    // Without a stand-in, fail closed rather than reach the real holder.
    const error = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${DEFAULT_VIEW_PORT}`),
      { code: 'ECONNREFUSED', errno: -61, syscall: 'connect', port: DEFAULT_VIEW_PORT });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  const moved = options ? { ...options, port: standIn } : standIn;
  // net.createConnection passes a normalized array tagged by Node; replace in place to keep that tag.
  if (Array.isArray(args[0])) args[0][0] = moved;
  else args[0] = moved;
  return connect.apply(this, args);
};
