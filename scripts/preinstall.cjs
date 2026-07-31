#!/usr/bin/env node
/**
 * preinstall.cjs — toolchain version guard.
 *
 * Runs before any `pnpm install` and exits non-zero with a clear, actionable
 * message if the active Node.js or package manager version does not satisfy
 * the engines constraints declared in package.json.
 *
 * Must be CommonJS (.cjs) and use only Node built-ins — no npm packages are
 * available yet when this script executes.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const RESET = '\x1b[0m';
const RED   = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD  = '\x1b[1m';

function fail(msg) {
  process.stderr.write(`\n${RED}${BOLD}[preinstall] ERROR:${RESET} ${msg}\n\n`);
  process.exit(1);
}

function warn(msg) {
  process.stderr.write(`${YELLOW}[preinstall] WARN:${RESET} ${msg}\n`);
}

// ── Node version check ──────────────────────────────────────────────────────

const nodeEngines = pkg.engines && pkg.engines.node;
if (nodeEngines) {
  const currentVersion = process.version; // e.g. "v20.15.0"
  const currentMajor = parseInt(currentVersion.slice(1).split('.')[0], 10);

  // Parse ">=20.0.0 <21.0.0" style constraints
  const geMatch = nodeEngines.match(/>=\s*(\d+)/);
  const ltMatch = nodeEngines.match(/<\s*(\d+)/);
  const minMajor = geMatch ? parseInt(geMatch[1], 10) : null;
  const maxMajor = ltMatch ? parseInt(ltMatch[1], 10) : null;

  const tooOld = minMajor !== null && currentMajor < minMajor;
  const tooNew = maxMajor !== null && currentMajor >= maxMajor;

  if (tooOld || tooNew) {
    fail(
      `Node ${currentVersion} does not satisfy engines.node: "${nodeEngines}".\n` +
      `  Current:  ${currentVersion}\n` +
      `  Required: ${nodeEngines}\n` +
      `\n` +
      `  Remediation:\n` +
      `    nvm use ${minMajor}       # if using nvm\n` +
      `    fnm use ${minMajor}       # if using fnm\n` +
      `    volta install node@${minMajor}  # if using Volta`
    );
  }
}

// ── Package manager check ────────────────────────────────────────────────────

const requiredPM = pkg.packageManager; // e.g. "pnpm@9.7.1"
if (requiredPM) {
  const [pmName, pmVersion] = requiredPM.split('@');
  const userAgent = process.env.npm_config_user_agent || '';

  if (!userAgent) {
    // Can't detect — warn only, don't block
    warn(`Could not detect package manager from npm_config_user_agent. Expected: ${requiredPM}`);
  } else if (!userAgent.startsWith(pmName)) {
    fail(
      `Wrong package manager. Expected ${pmName}@${pmVersion}.\n` +
      `  Running: ${userAgent}\n` +
      `\n` +
      `  Remediation:\n` +
      `    corepack enable\n` +
      `    corepack use ${pmName}@${pmVersion}`
    );
  } else if (pmVersion && !userAgent.includes(pmVersion.split('+')[0])) {
    // Version mismatch — extract base version (before any + hash)
    const baseRequired = pmVersion.split('+')[0];
    const runningVersion = userAgent.split('/')[1]?.split(' ')[0] ?? 'unknown';
    if (runningVersion !== baseRequired) {
      warn(
        `Package manager version mismatch.\n` +
        `  Required: ${pmName}@${baseRequired}\n` +
        `  Running:  ${pmName}@${runningVersion}\n` +
        `  Run: corepack use ${pmName}@${baseRequired}`
      );
    }
  }
}
