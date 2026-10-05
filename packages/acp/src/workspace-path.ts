import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function workspacePath(cwd: string, path: string) {
  const root = await realpath(cwd);
  const canonical = await realpath(resolve(cwd, path));
  const local = relative(root, canonical);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error("File is outside this workspace.");
  }
  if (local.split(sep).some(part => [".git", ".local", ".pi"].includes(part))) {
    throw new Error("Private workspace storage is not available to file tools.");
  }
  return canonical;
}
