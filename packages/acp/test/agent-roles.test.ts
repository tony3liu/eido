import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgentRoles, manageAgentRoles, parseAgentRole } from "../src/agent-roles.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

test("global roles use pi YAML, preserve tool restrictions and isolate malformed files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eido-roles-"));
  const source = '---\nname: audit\ndescription: Inspect code\ntools: [read]\nmodel: configured/model\nthinking: high\n---\nCheck actual evidence.\n';
  try {
    await mkdir(join(dir, "agents"));
    await writeFile(join(dir, "agents", "audit.md"), source);
    await writeFile(join(dir, "agents", "broken.md"), "---\nname: ../escape\n---\nInvalid");
    await mkdir(join(dir, ".pi", "agents"), {recursive: true});
    await writeFile(join(dir, ".pi", "agents", "project.md"), source.replaceAll("audit", "project"));
    const {roles, errors} = await discoverAgentRoles(dir);
    assert.equal(roles.length, 5);
    assert.equal(roles.find(r => r.name === "audit")?.model, "configured/model");
    assert.equal(roles.find(r => r.name === "audit")?.thinking, "high");
    assert.equal(roles.some(r => r.name === "project"), false);
    assert.equal(errors.length, 1);
    assert.throws(() => parseAgentRole(source.replace("[read]", "[arbitrary-shell]")), /tools/);
    const ui = {editor: async () => source.replace("Inspect code", "Inspect current buffers")} as unknown as ExtensionUIContext;
    await manageAgentRoles(dir, "audit", ui);
    assert.match(await readFile(join(dir, "agents", "audit.md"), "utf8"), /Inspect current buffers/);
    const before = await readFile(join(dir, "agents", "audit.md"), "utf8");
    await assert.rejects(manageAgentRoles(dir, "audit", {editor: async () => "invalid"} as unknown as ExtensionUIContext));
    assert.equal(await readFile(join(dir, "agents", "audit.md"), "utf8"), before);
    await assert.rejects(manageAgentRoles(dir, "audit", {editor: async () => {
      await writeFile(join(dir, "agents", "audit.md"), source.replace("Inspect code", "Concurrent edit"));
      return source;
    }} as unknown as ExtensionUIContext), /changed while/);
    assert.match(await readFile(join(dir, "agents", "audit.md"), "utf8"), /Concurrent edit/);
    await writeFile(join(dir, "agents", "worker.md"), "invalid");
    assert.equal((await discoverAgentRoles(dir)).roles.some(r => r.name === "worker"), false, "an invalid override cannot silently regain built-in write access");
  } finally {await rm(dir, {recursive: true, force: true});}
});

test("role removal supports cancellation, concurrent edit protection and built-in reset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eido-role-delete-"));
  const role = '---\nname: audit\ndescription: Audit code\ntools: [read, extensions, mcp, "tool:plugin_tool", "mcp:fixture"]\n---\nAudit only.\n';
  try {
    await mkdir(join(dir, "agents"));
    const path = join(dir, "agents", "audit.md");
    await writeFile(path, role);
    assert.equal(parseAgentRole(role).tools.length, 5);
    await manageAgentRoles(dir, "delete audit", {confirm: async () => false} as unknown as ExtensionUIContext);
    assert.equal(await readFile(path, "utf8"), role);
    await assert.rejects(manageAgentRoles(dir, "delete audit", {confirm: async () => {
      await writeFile(path, role + "A concurrent correction.\n"); return true;
    }} as unknown as ExtensionUIContext), /changed while/);
    assert.match(await readFile(path, "utf8"), /concurrent correction/);
    await manageAgentRoles(dir, "delete audit", {confirm: async () => true} as unknown as ExtensionUIContext);
    assert.equal((await discoverAgentRoles(dir)).roles.some(r => r.name === "audit"), false);
    await writeFile(join(dir, "agents", "worker.md"), role.replace("name: audit", "name: worker"));
    await manageAgentRoles(dir, "reset worker", {confirm: async () => true} as unknown as ExtensionUIContext);
    const worker = (await discoverAgentRoles(dir)).roles.find(r => r.name === "worker");
    assert.ok(worker?.tools.includes("write"));
    assert.ok(worker?.tools.includes("extensions"));
    assert.ok(worker?.tools.includes("mcp"));
    await assert.rejects(manageAgentRoles(dir, "delete worker", {confirm: async () => true} as unknown as ExtensionUIContext), /no custom/);
  } finally {await rm(dir, {recursive: true, force: true});}
});
