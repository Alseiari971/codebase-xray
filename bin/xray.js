#!/usr/bin/env node
// Runs the TypeScript sources directly through tsx so there is no build step.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
process.exitCode = await main();
