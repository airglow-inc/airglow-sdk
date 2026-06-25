// Verifies `ensureBinOnShellPath`: writes a marker-guarded block to the right
// shell startup files, is idempotent (no duplication on reinstall), updates the
// path in place when it changes, and never touches the user's existing lines.
// `home` is injected so the test never reads or writes the real $HOME (Bun's
// os.homedir() ignores a runtime process.env.HOME override).

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBinOnShellPath } from '../src/install';

let home: string;
const savedShell = process.env.SHELL;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'agl-home-')); });
afterEach(() => { process.env.SHELL = savedShell; rmSync(home, { recursive: true, force: true }); });

const count = (s: string, sub: string) => s.split(sub).length - 1;
const bin = () => join(home, '.airglow/bin');

test('zsh: writes block to .zshrc and .zprofile with $HOME-relative path', () => {
  process.env.SHELL = '/bin/zsh';
  ensureBinOnShellPath(bin(), home);
  for (const f of ['.zshrc', '.zprofile']) {
    const body = readFileSync(join(home, f), 'utf8');
    expect(body).toContain('# >>> airglow PATH >>>');
    expect(body).toContain('export PATH="$HOME/.airglow/bin:$PATH"');
  }
});

test('bash: prefers .bash_profile over .profile when it exists', () => {
  process.env.SHELL = '/usr/bin/bash';
  writeFileSync(join(home, '.bash_profile'), '# mine\n');
  ensureBinOnShellPath(bin(), home);
  const body = readFileSync(join(home, '.bash_profile'), 'utf8');
  expect(body).toContain('# >>> airglow PATH >>>');
  expect(body).toContain('# mine'); // existing line preserved
  expect(existsSync(join(home, '.profile'))).toBe(false);
});

test('idempotent: re-running does not duplicate the block', () => {
  process.env.SHELL = '/bin/zsh';
  ensureBinOnShellPath(bin(), home);
  ensureBinOnShellPath(bin(), home);
  ensureBinOnShellPath(bin(), home);
  const body = readFileSync(join(home, '.zshrc'), 'utf8');
  expect(count(body, '# >>> airglow PATH >>>')).toBe(1);
  expect(count(body, '# <<< airglow PATH <<<')).toBe(1);
});

test('updates the path in place when the bin dir changes', () => {
  process.env.SHELL = '/bin/zsh';
  ensureBinOnShellPath('/opt/old/bin', home);
  ensureBinOnShellPath(bin(), home);
  const body = readFileSync(join(home, '.zshrc'), 'utf8');
  expect(count(body, '# >>> airglow PATH >>>')).toBe(1);
  expect(body).toContain('export PATH="$HOME/.airglow/bin:$PATH"');
  expect(body).not.toContain('/opt/old/bin');
});

test('appends after existing content without clobbering it', () => {
  process.env.SHELL = '/bin/zsh';
  writeFileSync(join(home, '.zshrc'), 'export FOO=bar\nalias g=git\n');
  ensureBinOnShellPath(bin(), home);
  const body = readFileSync(join(home, '.zshrc'), 'utf8');
  expect(body).toContain('export FOO=bar');
  expect(body).toContain('alias g=git');
  expect(body.indexOf('export FOO=bar')).toBeLessThan(body.indexOf('# >>> airglow PATH >>>'));
});

test('unknown shell falls back to .profile only', () => {
  process.env.SHELL = '/usr/bin/fish';
  ensureBinOnShellPath(bin(), home);
  expect(existsSync(join(home, '.profile'))).toBe(true);
  expect(existsSync(join(home, '.zshrc'))).toBe(false);
});
