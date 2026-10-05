import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { createPiSettings } from "./pi-settings.mjs";

const source = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"));
try {
  const status = await createPiSettings(undefined, source).execute({ operation: "import" });
  console.log(`Synced pi ${status.version}: ${status.defaultProvider}/${status.defaultModel}. Credential values are not printed.`);
} catch {
  console.error("pi configuration import failed. Check source and destination configuration files; credentials are never printed.");
  process.exitCode = 1;
}
