// The keep-awake refcount must never leak a power assertion (a laptop kept awake
// in a bag) and never double-spawn. These pin the state machine against a fake
// spawn — no real caffeinate/systemd-inhibit involved.
import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createKeepAwake } from '../src/daemon/keep-awake.ts';

// Minimal ChildProcess stand-in: records kills, can emit 'exit'/'error'.
function fakeProc() {
  const ee = new EventEmitter() as any;
  ee.kills = 0;
  ee.kill = () => { ee.kills++; return true; };
  return ee;
}

// A spawn stub that hands back a fresh fake proc per call and counts spawns.
function stubSpawn() {
  const procs: any[] = [];
  const fn = ((..._args: any[]) => { const p = fakeProc(); procs.push(p); return p; }) as any;
  return { fn, procs };
}

test('inhibitor runs only while >=1 turn is active; no double-spawn, no leak', () => {
  const { fn, procs } = stubSpawn();
  const k = createKeepAwake(fn);

  k.acquire();                       // 0 -> 1: spawn
  expect(procs.length).toBe(1);
  k.acquire();                       // 1 -> 2: must NOT spawn again
  expect(procs.length).toBe(1);
  k.release();                       // 2 -> 1: must NOT kill
  expect(procs[0].kills).toBe(0);
  k.release();                       // 1 -> 0: kill
  expect(procs[0].kills).toBe(1);
});

test('a fresh turn after release spawns a new inhibitor', () => {
  const { fn, procs } = stubSpawn();
  const k = createKeepAwake(fn);
  k.acquire(); k.release();
  k.acquire(); k.release();
  expect(procs.length).toBe(2);
  expect(procs[0].kills).toBe(1);
  expect(procs[1].kills).toBe(1);
});

test('release underflow is a no-op (never kills a process it does not hold)', () => {
  const { fn, procs } = stubSpawn();
  const k = createKeepAwake(fn);
  k.release();                       // count already 0
  expect(procs.length).toBe(0);
  k.acquire();
  k.release();
  k.release();                       // extra release must not throw or re-kill
  expect(procs[0].kills).toBe(1);
});

test('an inhibitor that exits on its own is not killed again on release', () => {
  const { fn, procs } = stubSpawn();
  const k = createKeepAwake(fn);
  k.acquire();
  procs[0].emit('exit', 0);          // caffeinate died (e.g. crash backstop fired)
  k.release();                       // 1 -> 0: nothing to kill
  expect(procs[0].kills).toBe(0);
});
