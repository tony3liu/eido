import {join} from 'node:path';

// Installed apps keep mutable pi state outside their read-only runtime bundle.
export function piDirectory(root) {
  return process.env.EIDO_PI_CONFIG_DIR || join(root, '.local/eido');
}
