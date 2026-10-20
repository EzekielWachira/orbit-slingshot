// Promise wrapper around the solver worker, so heavy searches never stall a frame.
import type { LevelDef } from './physics.ts';
import type { SolveOptions, SolveReport } from './solver.ts';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (v: unknown) => void>();

function get(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      pending.get(e.data.id)?.(e.data.result);
      pending.delete(e.data.id);
    };
  }
  return worker;
}

function call<T>(msg: object): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve) => {
    pending.set(id, resolve as (v: unknown) => void);
    get().postMessage({ ...msg, id });
  });
}

export const solveAsync = (level: LevelDef, opts: SolveOptions) => call<SolveReport>({ type: 'solve', level, opts });
export const dailyAsync = (key: string) => call<LevelDef>({ type: 'daily', key });
