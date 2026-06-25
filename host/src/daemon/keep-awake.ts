// Hold an OS power assertion while the agent is mid-turn, so a long turn isn't
// guillotined by idle sleep. A laptop dozing on battery mid-stream tears down
// the model connection — the turn then has to detect the dead socket and resume
// (see the idle-timeout recovery in agent/api.ts). Preventing idle sleep while a
// turn is in flight removes that trigger entirely: the machine stays awake, the
// stream finishes, nothing has to recover.
//
// Scope is deliberately narrow on two axes:
//   - Time: refcounted to active turns. The inhibitor runs only while >=1 turn
//     is in flight and is released on every exit path. A power assertion held
//     past a turn is the one real hazard here (a laptop kept awake in a bag) —
//     the refcount + the crash backstop below close it.
//   - Coverage: this prevents *idle* sleep only. Closing the lid (clamshell)
//     still sleeps the machine; that case stays the recovery layer's job.

import { spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';

export interface KeepAwake {
  acquire(): void;
  release(): void;
}

// The platform inhibitor invocation, or null on an unsupported platform (then
// keep-awake is a no-op and recovery alone carries it). On macOS, `-w <pid>` is
// the crash backstop: if the daemon is SIGKILLed mid-turn, caffeinate self-exits
// instead of leaving the machine awake. On Linux, systemd-inhibit holds the lock
// for as long as the trivial waiter it wraps lives; we kill it on release, and
// it dies with the daemon since it's our child.
function inhibitorCommand(): { cmd: string; args: string[] } | null {
  if (platform() === 'darwin') {
    return { cmd: 'caffeinate', args: ['-i', '-w', String(process.pid)] };
  }
  if (platform() === 'linux') {
    return {
      cmd: 'systemd-inhibit',
      args: ['--what=idle', '--who=airglow', '--why=agent turn in progress', '--mode=block', 'sleep', 'infinity'],
    };
  }
  return null;
}

// `spawnFn` is injectable so the refcount state machine (the leak-critical part)
// can be unit-tested without launching a real inhibitor.
export function createKeepAwake(spawnFn: typeof spawn = spawn): KeepAwake {
  let count = 0;
  let proc: ChildProcess | null = null;
  // Once an inhibitor binary is found missing, stop trying — avoids spawning a
  // doomed child on every turn when caffeinate/systemd-inhibit isn't present.
  let disabled = false;

  function start(): void {
    if (disabled || proc) return;
    const spec = inhibitorCommand();
    if (!spec) { disabled = true; return; }
    try {
      const child = spawnFn(spec.cmd, spec.args, { stdio: 'ignore' });
      child.on('error', () => { if (proc === child) proc = null; disabled = true; }); // binary missing
      child.on('exit', () => { if (proc === child) proc = null; });
      proc = child;
    } catch {
      proc = null;
      disabled = true;
    }
  }

  function stop(): void {
    if (!proc) return;
    try { proc.kill(); } catch {}
    proc = null;
  }

  return {
    acquire(): void {
      count++;
      if (count === 1) start();
    },
    release(): void {
      if (count === 0) return;
      count--;
      if (count === 0) stop();
    },
  };
}
