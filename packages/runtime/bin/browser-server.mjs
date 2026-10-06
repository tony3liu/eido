import { fileURLToPath } from "node:url";
import { browserDirectory } from "../src/paths.mjs";
import { browserDecisionEnvironment } from "../src/browser/config.mjs";

// Resolve resources before Playwright is imported by the browser service.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= browserDirectory();
process.env.JEV_BROWSER_HEADED ??= "1";
process.env.JEV_BROWSER_LOG = "0";
delete process.env.JEV_BROWSER_PROFILE;
Object.assign(process.env, await browserDecisionEnvironment(process.env.EIDO_PI_CONFIG_DIR ?? fileURLToPath(new URL("../../../.local/eido", import.meta.url))));
const { serveBrowser } = await import("../src/browser/server.mjs");
await serveBrowser();
