#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const docsRoot = path.join(root, "docs");
const failures = [];

function fail(message) {
  failures.push(message);
}

function walk(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(target) : [target];
    });
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function markdownWithoutFences(markdown) {
  return markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
}

function markdownLinks(markdown) {
  const links = [];
  const source = markdownWithoutFences(markdown);
  const pattern = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of source.matchAll(pattern)) {
    links.push(match[1].replace(/^<|>$/g, ""));
  }
  return links;
}

function headingSlug(heading) {
  return heading
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function anchorsFor(markdown) {
  const anchors = new Set();
  const duplicates = new Map();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = headingSlug(match[1]);
    const seen = duplicates.get(base) ?? 0;
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
    duplicates.set(base, seen + 1);
  }
  return anchors;
}

const markdownFiles = walk(docsRoot).filter((file) => file.endsWith(".md"));
const checkedDocs = markdownFiles.filter((file) => path.basename(file) !== "TEMPLATE.md");
const bodies = new Map(markdownFiles.map((file) => [file, fs.readFileSync(file, "utf8")]));

for (const file of checkedDocs) {
  const body = bodies.get(file);
  for (const link of markdownLinks(body)) {
    if (/^(https?:|mailto:)/.test(link)) continue;

    const hashIndex = link.indexOf("#");
    const rawTarget = hashIndex === -1 ? link : link.slice(0, hashIndex);
    const anchor = hashIndex === -1 ? "" : link.slice(hashIndex + 1);
    let decodedTarget;
    try {
      decodedTarget = decodeURIComponent(rawTarget);
    } catch {
      fail(`${relative(file)}: invalid encoded link ${link}`);
      continue;
    }

    const target = rawTarget
      ? path.resolve(path.dirname(file), decodedTarget)
      : file;
    if (!fs.existsSync(target)) {
      fail(`${relative(file)}: missing link target ${link}`);
      continue;
    }
    if (anchor) {
      if (!fs.statSync(target).isFile()) {
        fail(`${relative(file)}: anchor targets non-file ${link}`);
        continue;
      }
      const targetBody = bodies.get(target) ?? fs.readFileSync(target, "utf8");
      if (!anchorsFor(targetBody).has(anchor)) {
        fail(`${relative(file)}: missing anchor ${link}`);
      }
    }
  }
}

const docsIndex = path.join(docsRoot, "README.md");
const indexedTargets = new Set(
  markdownLinks(bodies.get(docsIndex))
    .filter((link) => !/^(https?:|mailto:|#)/.test(link))
    .map((link) => link.split("#", 1)[0])
    .filter(Boolean)
    .map((link) => path.resolve(path.dirname(docsIndex), decodeURIComponent(link))),
);
for (const file of checkedDocs) {
  if (file === docsIndex) continue;
  if (!indexedTargets.has(file)) {
    fail(`${relative(file)}: missing direct entry in docs/README.md`);
  }
}

const adrFiles = checkedDocs
  .filter((file) => path.dirname(file) === path.join(docsRoot, "adr"))
  .sort();
for (const [index, file] of adrFiles.entries()) {
  const expected = String(index + 1).padStart(4, "0");
  if (!path.basename(file).startsWith(`${expected}-`)) {
    fail(`${relative(file)}: expected sequential ADR number ${expected}`);
  }
  const status = bodies.get(file).match(/^- \*\*Status:\*\* (.+)$/m)?.[1];
  if (!status || !/^(Accepted|Proposed|Superseded by )/.test(status)) {
    fail(`${relative(file)}: missing or invalid ADR status`);
  }
}

const prdFiles = checkedDocs.filter(
  (file) => path.dirname(file) === path.join(docsRoot, "prd"),
);
for (const file of prdFiles) {
  const body = bodies.get(file);
  const requirements = body.match(/(?:^|\n)## Requirements\n([\s\S]*?)(?=\n## |$)/)?.[1];
  if (!requirements) {
    fail(`${relative(file)}: missing Requirements section`);
    continue;
  }
  const numbers = [...requirements.matchAll(/^([0-9]+)\. /gm)].map((match) => Number(match[1]));
  if (numbers.length === 0) {
    fail(`${relative(file)}: Requirements section contains no numbered requirements`);
    continue;
  }
  for (const [index, number] of numbers.entries()) {
    if (number !== index + 1) {
      fail(`${relative(file)}: requirement ${index + 1} is numbered ${number}`);
      break;
    }
  }
}

const domainFiles = checkedDocs.filter(
  (file) => path.dirname(file) === path.join(docsRoot, "domain"),
);
for (const file of domainFiles) {
  const body = bodies.get(file);
  const terms = body.match(/(?:^|\n)## Terms\n([\s\S]*?)(?=\n## |$)/)?.[1];
  if (!terms) {
    fail(`${relative(file)}: missing Terms section`);
    continue;
  }
  const entries = [...terms.matchAll(/^#### (.+)\n([\s\S]*?)(?=^#{2,4} |(?![^]))/gm)];
  if (entries.length === 0) {
    fail(`${relative(file)}: Terms section contains no canonical entries`);
    continue;
  }
  const names = new Set();
  for (const [, name, entry] of entries) {
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) {
      fail(`${relative(file)}: duplicate canonical term ${name}`);
    }
    names.add(normalizedName);
    if (!/^\*\*Avoid:\*\*/m.test(entry)) {
      fail(`${relative(file)}: term ${name} has no Avoid entry`);
    }
    const adrLinks = [...entry.matchAll(/\]\(\.\.\/adr\/(\d{4}-[^)]+\.md)\)/g)];
    if (adrLinks.length === 0) {
      fail(`${relative(file)}: term ${name} has no ADR link`);
    }
    for (const match of adrLinks) {
      const adr = path.join(docsRoot, "adr", match[1]);
      const adrBody = bodies.get(adr);
      if (!adrBody?.includes("- **Status:** Accepted")) {
        fail(`${relative(file)}: term ${name} cites a missing or non-Accepted ADR ${match[1]}`);
      }
    }
  }
}

const contextPath = path.join(root, "CONTEXT.md");
const expectedContextTarget = "docs/domain/ubiquitous-language.md";
if (!fs.existsSync(contextPath) || !fs.lstatSync(contextPath).isSymbolicLink()) {
  fail("CONTEXT.md: must be a symlink to the canonical domain language");
} else if (fs.readlinkSync(contextPath) !== expectedContextTarget) {
  fail(`CONTEXT.md: expected target ${expectedContextTarget}`);
}

if (failures.length > 0) {
  console.error(`Documentation validation failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const requirementCount = prdFiles.reduce((total, file) => {
  const requirements = bodies
    .get(file)
    .match(/(?:^|\n)## Requirements\n([\s\S]*?)(?=\n## |$)/)?.[1];
  return total + [...requirements.matchAll(/^([0-9]+)\. /gm)].length;
}, 0);
const termCount = domainFiles.reduce((total, file) => {
  const terms = bodies.get(file).match(/(?:^|\n)## Terms\n([\s\S]*?)(?=\n## |$)/)?.[1];
  return total + [...terms.matchAll(/^#### /gm)].length;
}, 0);

console.log(
  `Documentation valid: ${checkedDocs.length} docs, ${adrFiles.length} ADRs, ` +
    `${requirementCount} requirements, ${termCount} domain terms`,
);
