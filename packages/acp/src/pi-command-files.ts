import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export async function exportPiSession(pi: AgentSession, argument: string, agentDir: string) {
  const directory = join(agentDir, "exports");
  await mkdir(directory, {recursive: true});
  const quoted = /^(["'])([\s\S]*)\1$/.exec(argument);
  const requested = quoted?.[2] ?? argument;
  const destination = requested
    ? resolve(pi.sessionManager.getCwd(), requested)
    : join(directory, `${pi.sessionId}-${Date.now()}.html`);
  const extension = extname(destination).toLowerCase();
  if (extension !== ".html" && extension !== ".jsonl") throw new Error("Export path must end in .html or .jsonl.");
  const temporary = await mkdtemp(join(directory, ".export-"));
  try {
    const output = join(temporary, `session${extension}`);
    if (extension === ".jsonl") pi.exportToJsonl(output);
    else await pi.exportToHtml(output);
    // Do not overwrite source files or earlier exports. COPYFILE_EXCL also
    // closes the existence-check race and rejects an existing symlink target.
    await copyFile(output, destination, constants.COPYFILE_EXCL);
    return `Session exported to [${destination}](<${destination}>).`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Export destination already exists. Choose a new filename.");
    throw error;
  } finally { await rm(temporary, {recursive: true, force: true}); }
}

export async function piChangelog() {
  const packageDirectory = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  const source = await readFile(join(packageDirectory, "CHANGELOG.md"), "utf8");
  const sections = source.split(/(?=^## )/m);
  return sections.slice(0, 4).join("").trim();
}
