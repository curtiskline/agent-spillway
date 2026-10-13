#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const plugin = join(dirname(dirname(fileURLToPath(import.meta.url))), "plugins", "spillway");
const files = [];
async function inventory(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error("Plugin footprint refuses linked assets.");
    if (entry.isDirectory()) await inventory(join(directory, entry.name), relative + "/");
    else if (entry.isFile()) files.push(relative);
    else throw new Error("Plugin footprint requires regular assets.");
  }
}
await inventory(plugin);
const entries = [];
for (const path of files.sort()) {
  const text = await readFile(join(plugin, path), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  let descriptor = "";
  let body = text;
  if (frontmatter) {
    const metadata = parse(frontmatter[1]);
    if (typeof metadata?.name !== "string" || typeof metadata?.description !== "string")
      throw new Error("Plugin skill/agent requires a name and description.");
    descriptor = metadata.name + "\n" + metadata.description;
    body = text.slice(frontmatter[0].length);
  } else if (path === ".claude-plugin/plugin.json") {
    const metadata = JSON.parse(text);
    descriptor = metadata.name + "\n" + metadata.description;
  }
  entries.push({
    path,
    fileBytes: Buffer.byteLength(text),
    descriptorBytes: Buffer.byteLength(descriptor),
    bodyBytes: Buffer.byteLength(body),
  });
}
const sum = field => entries.reduce((total, entry) => total + entry[field], 0);
process.stdout.write(JSON.stringify({
  version: 1,
  scope: "static-plugin-assets",
  tokenCount: null,
  exclusions: ["runtime MCP tool descriptions", "hook output", "vendor/session context"],
  totals: { fileBytes: sum("fileBytes"), descriptorBytes: sum("descriptorBytes"), bodyBytes: sum("bodyBytes") },
  entries,
}, null, 2) + "\n");
