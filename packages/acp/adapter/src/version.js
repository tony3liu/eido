// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { readFileSync } from "node:fs";
export const PKG_VERSION = String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
