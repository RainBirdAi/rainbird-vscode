#!/usr/bin/env node
/**
 * Waits until the version in package.json is live on the VS Code Marketplace or Open VSX, and
 * exits non-zero if it is not live in time. Used by the verify-* jobs in .gitlab-ci.yml after
 * the manual publish jobs. The Marketplace scans every upload before serving it, so a successful
 * `vsce publish` alone does not mean users can install the new version yet.
 *
 * Usage: node scripts/verify-published.mjs <marketplace|openvsx> [--version X.Y.Z] [--minutes N] [--interval S]
 *
 * "Live" means the store's latest version is the expected one and its display name matches
 * package.json. Needs Node 18+ (global fetch) and no npm packages.
 */
import { readFileSync } from "node:fs";

const [store, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) options[args[i].replace(/^--/, "")] = args[i + 1];

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const id = `${manifest.publisher}.${manifest.name}`;
const version = options.version ?? manifest.version;
const minutes = Number(options.minutes ?? 20);
const intervalMs = Number(options.interval ?? 30) * 1000;

const STORES = {
  marketplace: {
    label: "VS Code Marketplace",
    page: `https://marketplace.visualstudio.com/items?itemName=${id}`,
    async latest() {
      const response = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json;api-version=3.0-preview.1" },
        // filterType 7: match "publisher.name". Flags: IncludeVersions (0x1), ExcludeNonValidated
        // (0x20, so a version still being scanned does not count) and IncludeLatestVersionOnly (0x200).
        body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: id }] }], flags: 0x1 | 0x20 | 0x200 }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const extension = (await response.json()).results?.[0]?.extensions?.[0];
      return { version: extension?.versions?.[0]?.version, displayName: extension?.displayName };
    },
  },
  openvsx: {
    label: "Open VSX",
    page: `https://open-vsx.org/extension/${manifest.publisher}/${manifest.name}`,
    async latest() {
      const response = await fetch(`https://open-vsx.org/api/${manifest.publisher}/${manifest.name}`);
      if (response.status === 404) return {};
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const extension = await response.json();
      return { version: extension.version, displayName: extension.displayName };
    },
  },
};

const target = STORES[store];
if (!target) {
  console.error(`Unknown store "${store ?? ""}". Use one of: ${Object.keys(STORES).join(", ")}.`);
  process.exit(2);
}

const deadline = Date.now() + minutes * 60_000;
for (let check = 1; ; check++) {
  let seen;
  try {
    seen = await target.latest();
  } catch (error) {
    seen = { error: error instanceof Error ? error.message : String(error) };
  }
  if (seen.version === version && seen.displayName === manifest.displayName) {
    console.log(`${target.label}: ${id} ${version} ("${seen.displayName}") is live. ${target.page}`);
    process.exit(0);
  }
  const state = seen.error
    ? `the query failed (${seen.error})`
    : `the latest version is ${seen.version ?? "none"}${seen.displayName ? ` ("${seen.displayName}")` : ""}`;
  if (Date.now() + intervalMs > deadline) {
    console.error(
      `${target.label}: ${id} ${version} ("${manifest.displayName}") is not live after ${minutes} min: ${state}. ` +
        `Check the publish job's log and ${target.page}`
    );
    process.exit(1);
  }
  console.log(`${target.label}: waiting for ${version}; ${state} (check ${check}).`);
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
