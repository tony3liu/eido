import { fileURLToPath } from "node:url";
import { browserDecisionEnvironment } from "../src/browser/config.mjs";

// Keep the published server's tools and lifecycle. Eido supplies its pinned
// browser cache and a visible, independent session for development verification.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL("../../../.local/browsers", import.meta.url));
process.env.JEV_BROWSER_HEADED ??= "1";
process.env.JEV_BROWSER_LOG = "0";
delete process.env.JEV_BROWSER_PROFILE;
Object.assign(process.env, await browserDecisionEnvironment(process.env.EIDO_PI_CONFIG_DIR ?? fileURLToPath(new URL("../../../.local/eido", import.meta.url))));
await import("../../../node_modules/jev-browser/bin/jev-browser-mcp.mjs");
