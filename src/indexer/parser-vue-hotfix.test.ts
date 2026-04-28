import { describe, it, expect } from "vitest";
import { parseVue, parseSFCBlocks, extractComponentRefs } from "./parser-vue.js";

describe("parseVue — v0.18.1 hotfix (findings 3, 4, 8, 11)", () => {
  it("Finding 3: merges imports from BOTH <script> and <script setup>", () => {
    const sfc = `<script lang="ts">
import OnlyInPlain from './only-in-plain'
export default { name: 'Foo' }
</script>

<script setup lang="ts">
import OnlyInSetup from './only-in-setup'
const x = 1
</script>
`;
    const result = parseVue(sfc, sfc.split("\n"));
    const sources = result.imports.map((i) => i.source);
    expect(sources).toContain("./only-in-plain");
    expect(sources).toContain("./only-in-setup");
  });

  it("Finding 3: setup block is still the canonical source for symbols (only setup chunks)", () => {
    const sfc = `<script>
export class Helper { greet() { return 'hi' } }
</script>

<script setup>
function inSetup() { return 'setup' }
</script>
`;
    const result = parseVue(sfc, sfc.split("\n"));
    const names = result.chunks.map((c) => c.name);
    expect(names).toContain("inSetup");
    // Helper is in the secondary block — symbols not extracted, but
    // imports from that block ARE collected (verified above).
    expect(names).not.toContain("Helper");
  });

  it("Finding 4: HTML comments containing PascalCase tags don't produce false-positive imports", () => {
    const template = `
      <UserCard />
      <!-- TODO: replace with <NewWidget /> when ready -->
      <!-- <DeletedComponent /> was removed in v3 -->
    `;
    const refs = extractComponentRefs(template);
    expect(refs).toEqual(["UserCard"]);
    expect(refs).not.toContain("NewWidget");
    expect(refs).not.toContain("DeletedComponent");
  });

  it("Finding 4: PascalCase strings inside double-quoted attribute values are ignored", () => {
    const template = `
      <span tooltip="Show <Profile /> here"></span>
      <button title='Open <Settings />'>x</button>
      <RealComponent />
    `;
    const refs = extractComponentRefs(template);
    expect(refs).toEqual(["RealComponent"]);
  });

  it("Finding 4: PascalCase strings inside mustache interpolations are ignored", () => {
    const template = `
      <p>{{ 'Render <SecretComponent />' }}</p>
      <Real />
    `;
    const refs = extractComponentRefs(template);
    expect(refs).toEqual(["Real"]);
  });

  it("Finding 8: custom blocks (<i18n>, <route>) are captured as searchable chunks", () => {
    const sfc = `<template>
  <p>{{ t('hello') }}</p>
</template>

<i18n locale="en">
{
  "hello": "Hello world"
}
</i18n>

<route lang="json">
{ "meta": { "auth": true } }
</route>

<script setup>
const x = 1
</script>
`;
    const result = parseVue(sfc, sfc.split("\n"));
    const blockChunks = result.chunks.filter((c) => c.type === "block");
    const blockNames = blockChunks.map((c) => c.name);
    expect(blockNames).toContain("i18n");
    expect(blockNames).toContain("route");
    expect(blockNames).toContain("template");

    const i18nChunk = blockChunks.find((c) => c.name === "i18n");
    expect(i18nChunk?.content).toContain("Hello world");
    // The <i18n> tag has `locale="en"`, not `lang=...` — signature
    // captures lang only, so this is null (correct).
    expect(i18nChunk?.signature).toBeNull();

    const routeChunk = blockChunks.find((c) => c.name === "route");
    // The <route> tag DOES have `lang="json"` — signature should reflect that.
    expect(routeChunk?.signature).toBe("lang=json");
  });

  it("Finding 8: PascalCase tags inside template are NOT misidentified as custom blocks", () => {
    // Custom-block detection only matches lowercase tag names. A
    // PascalCase tag like <UserCard> in template should never get
    // emitted as a custom block.
    const sfc = `<template>
  <UserCard />
  <CustomElement />
</template>
`;
    const result = parseVue(sfc, sfc.split("\n"));
    const blockChunks = result.chunks.filter((c) => c.type === "block");
    const blockNames = blockChunks.map((c) => c.name);
    expect(blockNames).not.toContain("UserCard");
    expect(blockNames).not.toContain("CustomElement");
  });

  it("Finding 11: template component refs are deduped against script imports (basename match)", () => {
    const sfc = `<template>
  <UserCard :u="u" />
  <BaseAvatar />
  <BrandNewWidget />
</template>

<script setup lang="ts">
import UserCard from './UserCard.vue'
import BaseAvatar from './ui/BaseAvatar.vue'
const u = {}
</script>
`;
    const result = parseVue(sfc, sfc.split("\n"));
    const sources = result.imports.map((i) => i.source);
    // Real script imports preserved
    expect(sources).toContain("./UserCard.vue");
    expect(sources).toContain("./ui/BaseAvatar.vue");
    // Template-derived dupes suppressed
    expect(sources).not.toContain("./UserCard");
    expect(sources).not.toContain("./BaseAvatar");
    // Components NOT imported in script DO produce a template-derived
    // import edge (auto-import scenario)
    expect(sources).toContain("./BrandNewWidget");
  });

  it("Finding 11: dedup also matches by exact name in script's named-import list", () => {
    const sfc = `<template>
  <Button />
</template>

<script setup>
import { Button } from 'my-ui-lib'
</script>
`;
    const result = parseVue(sfc, sfc.split("\n"));
    const sources = result.imports.map((i) => i.source);
    expect(sources).toContain("my-ui-lib");
    expect(sources).not.toContain("./Button");
  });

  it("parseSFCBlocks: scriptSecondary holds the non-canonical script block when both exist", () => {
    const sfc = `<script lang="ts">
export default { name: 'Foo' }
</script>
<script setup>
const x = 1
</script>
`;
    const blocks = parseSFCBlocks(sfc);
    expect(blocks.script?.setup).toBe(true);
    expect(blocks.scriptSecondary).not.toBeNull();
    expect(blocks.scriptSecondary?.setup).toBe(false);
    expect(blocks.scriptSecondary?.content).toContain("Foo");
  });
});
