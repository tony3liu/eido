import { fileURLToPath } from "node:url";

// Keep the published server's tools and lifecycle. Eido supplies its pinned
// browser cache and a visible, independent session for development verification.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL("../.local/browsers", import.meta.url));
process.env.JEV_BROWSER_HEADED ??= "1";
process.env.JEV_BROWSER_LOG = "0";
delete process.env.JEV_BROWSER_PROFILE;
await import("../node_modules/jev-browser/bin/jev-browser-mcp.mjs");
