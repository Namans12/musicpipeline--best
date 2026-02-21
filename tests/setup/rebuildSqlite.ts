/**
 * Vitest Global Setup — Native Module Rebuild
 *
 * better-sqlite3 is a native Node.js addon. When `npm start` is run it gets
 * rebuilt for Electron's Node ABI (via electron-rebuild). Vitest tests run
 * under plain Node, so the addon must be rebuilt for the current Node ABI
 * before the test suite begins.
 *
 * This globalSetup runs once per `vitest run`/`vitest watch` invocation and
 * ensures the right binary is in place regardless of whether `npm start` was
 * run recently.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export default function setup(): void {
  try {
    execSync('npm rebuild better-sqlite3', {
      cwd: ROOT,
      stdio: 'pipe', // suppress output — it's noise in test logs
    });
  } catch {
    // If the rebuild fails (e.g. no compiler), tests that use better-sqlite3
    // will fail with a clear error. Don't throw here so other tests still run.
  }
}
