#!/usr/bin/env node
/*
 * Run the service and the Mock HCM concurrently for local dev.
 * No third-party concurrency dep; we just spawn two children, forward their output,
 * and shut both down cleanly on SIGINT/SIGTERM or when either exits.
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const children = [
  spawnChild('mock-hcm', 'npm', ['--workspace', '@time-off/mock-hcm', 'run', 'start:dev']),
  spawnChild('service', 'npm', ['--workspace', '@time-off/service', 'run', 'start:dev']),
];

let shuttingDown = false;
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function spawnChild(label, cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  prefix(child.stdout, label);
  prefix(child.stderr, label);
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.log(`[${label}] exited (code=${code}, signal=${signal}); shutting down siblings`);
      shutdown('child-exit');
    }
  });
  return { label, child };
}

function prefix(stream, label) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      console.log(`[${label}] ${line}`);
    }
  });
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${reason})...`);
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 2000).unref();
}
