import { solve } from './solver.ts';
import { generateDaily } from './daily.ts';

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'solve') self.postMessage({ id: msg.id, result: solve(msg.level, msg.opts) });
  else if (msg.type === 'daily') self.postMessage({ id: msg.id, result: generateDaily(msg.key) });
};
