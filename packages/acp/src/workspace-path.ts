import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, basename, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";

const privatePart = (part: string) => [".git", ".local", ".pi"].includes(part.toLowerCase()) || part.toLowerCase().startsWith(".eido-review-");

export async function workspacePath(cwd: string, path: string, allowMissing = false) {
  const root = await realpath(cwd);
  let ancestor = resolve(cwd, path);
  const suffix: string[] = [];
  let canonical: string;
  for (;;) {
    try { canonical = resolve(await realpath(ancestor), ...suffix); break; }
    catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink is not a new file. Do not reinterpret its target.
      const entry = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (entry || dirname(ancestor) === ancestor) throw error;
      suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  const local = relative(root, canonical);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error("File is outside this workspace.");
  }
  if (local.split(sep).some(privatePart)) {
    throw new Error("Private workspace storage is not available to file tools.");
  }
  return canonical;
}

// Workspace build outputs are a separate, read-only view. Never search .local
// implicitly or apply this exception to native read/write or editor mutations.
const buildDirectories = new Set(["bridge-target", "cua-target", "native-app", "native-target", "upstream"]);
const buildText = new Set([
  "cua-applied.json", "cua-build.json", "native-applied.json", "native-assets.json", "native-build.json",
  "native-build.log", "native-check.log", "native-status.json",
]);

const isSourcePart = (part: string) => !part.startsWith(".") && !["node_modules", "target"].includes(part.toLowerCase());
const isReferenceText = (name: string) => name === "Cargo.toml" || name.endsWith(".rs");

export async function buildArtifactPath(cwd: string, path: string, purpose: "read" | "list" | "find") {
  const [storage, name, ...parts] = relative(resolve(cwd), resolve(cwd, path)).split(sep);
  if (storage !== ".local") return;
  const upstream = name === "upstream" && parts[0] === "zed" && parts[1] === "crates" && parts.every(isSourcePart);
  const text = name && buildText.has(name) && parts.length === 0;
  if (purpose === "read" && !text && !(upstream && parts.length > 2 && isReferenceText(parts.at(-1)!))) return;
  if (purpose === "find" && !upstream) return;
  if (purpose === "list" && name && (!buildDirectories.has(name) || parts.some(privatePart))) return;
  const expected = resolve(await realpath(cwd), storage, ...(name ? [name, ...parts] : []));
  if (await realpath(expected) !== expected) throw new Error("Build artifact paths cannot follow symlinks.");
  return expected;
}

/** Explicit searches of native reference sources only. Do not read symlink
 * targets or expand this directory into ordinary workspace searches. */
export async function findBuildReferences(cwd: string, path: string, pattern: string, limit: number, signal?: AbortSignal) {
  const base = await buildArtifactPath(cwd, path, "find");
  if (!base) return;
  const paths: string[] = [];
  let scanned = 0;
  let bytes = 0;
  let truncated = false;
  const normalized = pattern.replace(/^(?:\.\/)+/, "");
  async function visit(directory: string) {
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (++scanned > 10_000) { truncated = true; return; }
      if (!isSourcePart(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (await realpath(absolute) === absolute) await visit(absolute);
        if (truncated) return;
      } else if (entry.isFile() && isReferenceText(entry.name)) {
        const local = relative(base!, absolute).split(sep).join("/");
        if (!matchesGlob(normalized.includes("/") ? local : entry.name, normalized)) continue;
        bytes += Buffer.byteLength(local) + 1;
        if (paths.length >= limit || bytes > 50 * 1024) { truncated = true; return; }
        paths.push(local);
      }
    }
  }
  await visit(base);
  return {output: (paths.join("\n") || "No files found matching pattern")
    + (truncated ? "\n\n[Results truncated. Narrow the source directory or glob.]" : ""), truncated};
}

export async function listBuildArtifacts(cwd: string, path: string, limit: number) {
  const canonical = await buildArtifactPath(cwd, path, "list");
  if (!canonical) return;
  const topLevel = basename(canonical) === ".local";
  const entries = (await readdir(canonical, {withFileTypes: true}))
    .filter(entry => (entry.isDirectory() || entry.isFile()) && !privatePart(entry.name)
      && (!topLevel || (entry.isDirectory() ? buildDirectories : buildText).has(entry.name)))
    .map(entry => entry.name + (entry.isDirectory() ? "/" : ""))
    .sort();
  return {output: entries.slice(0, limit).join("\n") || "(empty directory)", truncated: entries.length > limit};
}

export async function readToolText(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const maxBytes = 4 * 1024 * 1024;
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Only regular text files without additional hard links are supported here.");
    if (stat.size > maxBytes) throw new Error("This file exceeds the 4 MiB read limit. Inspect a smaller excerpt using the terminal.");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const {bytesRead} = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const output = buffer.subarray(0, offset);
    if (output.includes(0)) throw new Error("This file is not text.");
    return output;
  } finally { await file.close(); }
}
