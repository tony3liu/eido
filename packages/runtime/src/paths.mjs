import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Source checkouts and installed bundles share the same product package layout.
export const runtimeRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const bundledPiEntry = new URL('../../acp/node_modules/@earendil-works/pi-coding-agent/dist/index.js', import.meta.url);

// Installed apps keep mutable pi state outside their read-only runtime bundle.
export function piDirectory(root = runtimeRoot) {
  return process.env.EIDO_PI_CONFIG_DIR || join(root, '.local/eido');
}
