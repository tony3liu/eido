import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { workspacePath } from "./workspace-path.ts";

export type DependencyInput = {
  path: string; hash: string; mode: number; kind: "file" | "directory" | "link"; snapshotLink?: string;
};
export type Dependencies = { roots: string[]; entries: DependencyInput[]; bytes: number };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) => {
  const local = relative(root, path);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
};

/** Copy installed dependencies/assets without linking commands back to the workspace. */
export async function captureDependencies(root: string, paths: string[], destination: string, sources: string[], signal?: AbortSignal): Promise<Dependencies> {
  const entries: DependencyInput[] = [];
  const roots = [...new Set(await Promise.all(paths.map(path => workspacePath(root, path))))].sort();
  if (roots.some(path => path === root)) throw new Error("List dependency directories, not the entire workspace.");
  const unique = roots.filter(path => !roots.some(other => other !== path && inside(other, path)));
  for (const path of unique) {
    if (!(await lstat(path)).isDirectory()) throw new Error("Dependencies must be installed directories.");
    if (sources.some(source => inside(path, resolve(root, source)) || inside(resolve(root, source), path))) {
      throw new Error("Dependency directories must not overlap editor inputs.");
    }
  }
  let bytes = 0, visited = 0;
  async function visit(path: string) {
    signal?.throwIfAborted();
    if (++visited > 50_000) throw new Error("Dependency snapshot exceeds 50,000 entries.");
    const local = relative(root, path).split(sep).join("/");
    if (local.split("/").some(part => [".git", ".local", ".pi"].includes(part))) throw new Error("Dependency snapshot includes private storage.");
    const stat = await lstat(path), target = join(destination, local), mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const canonical = await realpath(path);
      if (!unique.some(base => inside(base, canonical))) throw new Error(`Dependency symlink leaves captured directories: ${local}`);
      const link = await readlink(path);
      // Resolve even relative chains into the copied tree. A copied link never
      // follows a workspace alias which might point to an uncaptured directory.
      const snapshotLink = relative(dirname(target), join(destination, relative(root, canonical)));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await symlink(snapshotLink, target);
      entries.push({ path: local, hash: digest(link), mode, kind: "link", snapshotLink });
    } else if (stat.isDirectory()) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      const names = (await readdir(path)).sort();
      entries.push({ path: local, hash: digest(JSON.stringify(names)), mode, kind: "directory" });
      for (const name of names) await visit(join(path, name));
    } else if (stat.isFile()) {
      if (stat.size + bytes > 256 * 1024 * 1024) throw new Error("Dependency snapshot exceeds 256 MiB. Select a smaller verification target.");
      const content = await readFile(path, { signal });
      bytes += content.byteLength;
      if (bytes > 256 * 1024 * 1024) throw new Error("Dependency snapshot exceeds 256 MiB. Select a smaller verification target.");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode, signal });
      entries.push({ path: local, hash: digest(content), mode, kind: "file" });
    } else throw new Error(`Unsupported dependency entry: ${local}`);
  }
  for (const path of unique) await visit(path);
  return { roots: unique.map(path => relative(root, path).split(sep).join("/")), entries, bytes };
}

export async function changedDependencies(root: string, inputs: DependencyInput[], signal?: AbortSignal, snapshot = false) {
  const changed: string[] = [], unavailable: string[] = [];
  for (const input of inputs) {
    if (signal?.aborted) { unavailable.push(input.path); continue; }
    try {
      const path = resolve(root, input.path), stat = await lstat(path);
      const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
      if (kind !== input.kind) { changed.push(input.path); continue; }
      if (snapshot && kind === "directory") continue; // Build caches are generated outputs, not original dependencies.
      const content = kind === "directory" ? JSON.stringify((await readdir(path)).sort()) : kind === "link" ? await readlink(path) : await readFile(path, { signal });
      const expected = snapshot && input.kind === "link" ? digest(input.snapshotLink!) : input.hash;
      // Snapshot directories are private; executable file permissions are preserved.
      if (digest(content) !== expected || (input.kind === "file" && (stat.mode & 0o777) !== input.mode)) changed.push(input.path);
    } catch { unavailable.push(input.path); }
  }
  return { changed, unavailable };
}
