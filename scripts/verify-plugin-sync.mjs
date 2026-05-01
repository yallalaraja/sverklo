#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { exit } from 'node:process';

const canonical = 'skill/sverklo-skill/SKILL.md';
const plugin = 'plugins/sverklo-skill/skills/sverklo-skill/SKILL.md';

const a = readFileSync(canonical, 'utf8');
const b = readFileSync(plugin, 'utf8');

if (a !== b) {
  console.error(`SKILL.md drift detected:`);
  console.error(`  canonical: ${canonical}`);
  console.error(`  plugin:    ${plugin}`);
  console.error(`Run: cp ${canonical} ${plugin}`);
  exit(1);
}

console.log(`plugin-sync: ${canonical} matches ${plugin}`);
