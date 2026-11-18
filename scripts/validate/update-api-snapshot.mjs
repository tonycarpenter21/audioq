#!/usr/bin/env node
/**
 * Writes api/public-api.json from the current src/index.ts. Run after an intentional API change
 * and commit the result together with a CHANGELOG entry.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { API_SNAPSHOT_PATH, readPublicApi } from './api.mjs';
import { abs } from './lib.mjs';

const api = readPublicApi();
mkdirSync(dirname(abs(API_SNAPSHOT_PATH)), { recursive: true });
writeFileSync(abs(API_SNAPSHOT_PATH), `${JSON.stringify(api, null, 2)}\n`);
console.log(`Wrote ${API_SNAPSHOT_PATH} (${Object.keys(api).length} exports)`);
