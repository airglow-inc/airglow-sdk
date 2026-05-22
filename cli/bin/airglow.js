#!/usr/bin/env node
'use strict';

// tsx loads .ts at runtime; esbuild is used by dev.ts for bundling.
// Both live in airglow-apps/node_modules (the workspace), not next to cli/,
// so resolve them from cwd (intended to be airglow-apps/).
const path = require('path');
const Module = require('module');

function requireFromWorkspace(spec) {
  const fromCwd = Module.createRequire(path.join(process.cwd(), 'package.json'));
  try {
    return fromCwd(spec);
  } catch {
    return require(spec);
  }
}

requireFromWorkspace('tsx/cjs');
require('../src/cli.ts');
