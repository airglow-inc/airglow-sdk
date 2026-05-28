#!/usr/bin/env node
'use strict';

// tsx loads .ts at runtime; esbuild is used by dev.ts for bundling.
// Both live in airglow-apps/node_modules (the workspace), not next to cli/,
// so resolve them from cwd (intended to be airglow-apps/).
const path = require('path');
const Module = require('module');
const http = require('http');
const { readFileSync } = require('fs');
const { execFileSync } = require('child_process');

function commandOutput(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 10_000,
  }).trim();
}

function commandOk(command, args, options = {}) {
  try {
    execFileSync(command, args, {
      cwd: options.cwd,
      stdio: 'ignore',
      timeout: options.timeout || 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function disabledFlag(value) {
  return /^(0|false|off|no)$/i.test(String(value || ''));
}

function devAppsDir() {
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apps-dir' && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--')) {
      return path.resolve(process.cwd(), args[i + 1]);
    }
    if (arg.startsWith('--apps-dir=')) {
      return path.resolve(process.cwd(), arg.slice('--apps-dir='.length));
    }
  }
  return process.cwd();
}

function localConfigPath(appsDir) {
  return path.join(appsDir, '.airglow', 'config.json');
}

function readLocalConfig(appsDir) {
  try {
    return JSON.parse(readFileSync(localConfigPath(appsDir), 'utf8'));
  } catch {
    return {};
  }
}

function autoUpdateDisabled() {
  if (process.env.AIRGLOW_AUTO_UPDATE !== undefined) {
    return disabledFlag(process.env.AIRGLOW_AUTO_UPDATE);
  }
  return readLocalConfig(devAppsDir()).autoUpdate === false;
}

function extensionReloadDisabled() {
  return disabledFlag(process.env.AIRGLOW_AUTO_RELOAD_EXTENSION);
}

function changedFiles(repoRoot, oldRef, newRef) {
  return commandOutput('git', [
    'diff',
    '--name-only',
    oldRef,
    newRef,
  ], { cwd: repoRoot }).split('\n').filter(Boolean);
}

function packageInputsChanged(files) {
  return files.some((file) => [
    'cli/package.json',
    'airglow-apps/package.json',
    'airglow-apps/pnpm-lock.yaml',
  ].includes(file));
}

function extensionChanged(files) {
  return files.some((file) => file.startsWith('extension/'));
}

function logManualExtensionReload() {
  console.log('  [airglow] Extension updated. Reload Airglow in Chrome to apply it.');
}

function requestExtensionReload() {
  const req = http.request({
    hostname: '127.0.0.1',
    port: 3101,
    path: '/reload',
    method: 'POST',
    timeout: 1500,
  }, (res) => {
    res.resume();
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      console.log('  [airglow] Reloaded Chrome extension.');
    } else {
      logManualExtensionReload();
    }
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', logManualExtensionReload);
  req.end();
}

function reloadExtensionIfPossible() {
  if (extensionReloadDisabled()) return;

  const req = http.request({
    hostname: '127.0.0.1',
    port: 3101,
    path: '/status',
    method: 'GET',
    timeout: 1500,
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      if (body.length < 4096) body += chunk;
    });
    res.on('end', () => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        logManualExtensionReload();
        return;
      }
      try {
        const status = JSON.parse(body);
        if (status && status.service === 'airglow-spy') {
          requestExtensionReload();
          return;
        }
      } catch {}
      logManualExtensionReload();
    });
    res.on('error', () => {
      logManualExtensionReload();
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => {
    logManualExtensionReload();
  });
  req.end();
}

function upstreamForCurrentBranch(repoRoot, branch) {
  try {
    return commandOutput('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: repoRoot });
  } catch {
    return branch === 'main' ? 'origin/main' : null;
  }
}

function remoteBranchHead(repoRoot, remote, remoteBranch) {
  const out = commandOutput('git', ['ls-remote', '--heads', remote, remoteBranch], { cwd: repoRoot, timeout: 10_000 });
  return out.split(/\s+/)[0] || null;
}

function runAutoUpdateIfSafe() {
  const command = process.argv[2];
  if (command !== 'dev') return;

  const repoRoot = path.resolve(__dirname, '..', '..');
  if (autoUpdateDisabled()) return;
  if (!commandOk('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot })) return;

  let branch;
  try {
    branch = commandOutput('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  } catch {
    return;
  }
  if (branch !== 'main') return;

  const upstream = upstreamForCurrentBranch(repoRoot, branch);
  if (!upstream) return;

  const slash = upstream.indexOf('/');
  if (slash <= 0 || slash === upstream.length - 1) return;
  const remote = upstream.slice(0, slash);
  const remoteBranch = upstream.slice(slash + 1);

  let oldHead;
  try {
    oldHead = commandOutput('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    const remoteHead = remoteBranchHead(repoRoot, remote, remoteBranch);
    if (!remoteHead || remoteHead === oldHead) return;
    commandOutput('git', ['fetch', '--quiet', remote, remoteBranch], { cwd: repoRoot, timeout: 30_000 });
    commandOutput('git', ['rev-parse', '--verify', upstream], { cwd: repoRoot });
  } catch {
    return;
  }

  let ahead = 0;
  let behind = 0;
  try {
    const counts = commandOutput('git', ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], { cwd: repoRoot });
    [ahead, behind] = counts.split(/\s+/).map((value) => Number(value) || 0);
  } catch {
    return;
  }

  if (behind === 0) return;
  if (ahead > 0) {
    console.log('  [airglow] Auto-update skipped: main has local commits.');
    return;
  }
  if (!commandOk('git', ['diff-index', '--quiet', 'HEAD', '--'], { cwd: repoRoot })) {
    console.log('  [airglow] Auto-update skipped: local tracked files changed.');
    return;
  }

  const files = changedFiles(repoRoot, oldHead, upstream);
  let newHead;
  try {
    commandOutput('git', ['merge', '--ff-only', upstream], { cwd: repoRoot, timeout: 30_000 });
    newHead = commandOutput('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    console.log(`  [airglow] Updated SDK ${oldHead.slice(0, 7)} -> ${newHead.slice(0, 7)}.`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.log(`  [airglow] Auto-update skipped: ${message}`);
    return;
  }

  if (process.env.AIRGLOW_AUTO_INSTALL !== '0' && packageInputsChanged(files)) {
    console.log('  [airglow] Installing updated dependencies...');
    try {
      execFileSync('pnpm', ['install', '--frozen-lockfile'], {
        cwd: path.join(repoRoot, 'airglow-apps'),
        stdio: 'inherit',
        timeout: 120_000,
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.log(`  [airglow] Dependency install failed: ${message}`);
    }
  }

  if (extensionChanged(files)) {
    reloadExtensionIfPossible();
  }
}

function requireFromWorkspace(spec) {
  const fromCwd = Module.createRequire(path.join(process.cwd(), 'package.json'));
  try {
    return fromCwd(spec);
  } catch {
    return require(spec);
  }
}

runAutoUpdateIfSafe();
requireFromWorkspace('tsx/cjs');
require('../src/cli.ts');
