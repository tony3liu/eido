import { existsSync, constants, accessSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserDecisionSettings } from "../../runtime/src/browser/config.mjs";

const require = createRequire(import.meta.url);
export const browserCachePath = process.env.PLAYWRIGHT_BROWSERS_PATH
  ?? fileURLToPath(new URL("../../../.local/browsers", import.meta.url));

export interface Adapter {
  id: string;
  surface: "browser" | "desktop";
  version: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function packageInfo(name: string) {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    const path = join(dir, "package.json");
    if (existsSync(path)) {
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      if (pkg.name === name) return { root: dir, version: String(pkg.version) };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Package manifest not found: ${name}`);
    dir = parent;
  }
}

export function findExecutable(command: string): string | undefined {
  const candidates = command.includes("/")
    ? [resolve(command)]
    : (process.env.PATH ?? "").split(delimiter).map((path) => join(path, command));
  return candidates.find((path) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
}

export function browserAdapter(cwd: string, headed = false): Adapter {
  const pkg = packageInfo("jev-browser");
  return {
    id: "jev-browser", surface: "browser", version: pkg.version,
    command: process.execPath,
    args: [fileURLToPath(new URL("../../runtime/bin/browser-server.mjs", import.meta.url))], cwd,
    env: {
      JEV_BROWSER_HEADED: headed ? "1" : "0",
      JEV_BROWSER_LOG: "0",
      PLAYWRIGHT_BROWSERS_PATH: browserCachePath,
      EIDO_PI_CONFIG_DIR: process.env.EIDO_PI_CONFIG_DIR ?? fileURLToPath(new URL("../../../.local/eido", import.meta.url)),
    },
  };
}

export function desktopAdapter(cwd: string): Adapter {
  const command = findExecutable(process.env.EIDO_CUA_DRIVER ?? "cua-driver");
  if (!command) throw new Error("Cua Driver is not installed. Set EIDO_CUA_DRIVER to its executable path.");
  return {
    id: "cua-driver", surface: "desktop", version: "unverified",
    command, args: ["mcp"], cwd, env: {},
  };
}

export async function doctor() {
  const pkg = packageInfo("jev-browser");
  const decision = await browserDecisionSettings(process.env.EIDO_PI_CONFIG_DIR ?? fileURLToPath(new URL("../../../.local/eido", import.meta.url)));
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserCachePath;
  const module = await import(require.resolve("playwright", { paths: [pkg.root] }));
  const playwright = module.default ?? module;
  const chromium = playwright.chromium.executablePath() as string;
  const driver = findExecutable(process.env.EIDO_CUA_DRIVER ?? "cua-driver");
  return {
    node: process.version,
    pi: JSON.parse(readFileSync(new URL("../../acp/node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version,
    browser: {
      package: `jev-browser@${pkg.version}`,
      control: existsSync(chromium) ? "available_unprobed" : "missing_chromium",
      decisionModel: decision.credential === "none" ? "configure_in_pi_settings" : "key_present_unverified",
      decision,
      chromium,
    },
    desktop: {
      driver: driver ?? null,
      status: driver ? "installed_unprobed" : "not_installed",
      permissions: "not_checked",
    },
  };
}
