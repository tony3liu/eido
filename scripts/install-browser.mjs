import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const cache = fileURLToPath(new URL("../.local/browsers", import.meta.url));
const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
const child = spawn(process.execPath, [cli, "install", "chromium"], {
  stdio: "inherit", env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? cache },
});
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
