#!/usr/bin/env node
import { runCli } from '../lib/onboard.js';

try { await runCli(process.argv.slice(2)); }
catch (error) {
  console.error('CrossAttest:', error.message);
  process.exitCode = 1;
}
