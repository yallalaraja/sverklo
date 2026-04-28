import { describe, it, expect } from "vitest";
import { parseVue, parseSFCBlocks, extractComponentRefs } from "./parser-vue.js";

describe("parseSFCBlocks", () => {
  it("extracts a Composition API SFC with all three blocks", () => {
    const sfc = `<template>
  <div>{{ greeting }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
const greeting = ref('hello')
</script>

<style scoped>
div { color: red; }
</style>
`;
    const blocks = parseSFCBlocks(sfc);
    expect(blocks.template).not.toBeNull();
    expect(blocks.script).not.toBeNull();
    expect(blocks.style).not.toBeNull();
    expect(blocks.script!.lang).toBe("ts");
    expect(blocks.script!.setup).toBe(true);
    expect(blocks.script!.content).toContain("import { ref }");
  });

  it("prefers <script setup> over plain <script> when both exist", () => {
    const sfc = `<script lang="ts">
export default { name: 'Legacy' }
</script>

<script setup lang="ts">
import { computed } from 'vue'
const total = computed(() => 1 + 2)
</script>
`;
    const blocks = parseSFCBlocks(sfc);
    expect(blocks.script).not.toBeNull();
    expect(blocks.script!.setup).toBe(true);
    expect(blocks.script!.content).toContain("computed");
    expect(blocks.script!.content).not.toContain("Legacy");
  });

  it("handles missing blocks (template-only SFC)", () => {
    const sfc = `<template>
  <p>just markup</p>
</template>
`;
    const blocks = parseSFCBlocks(sfc);
    expect(blocks.template).not.toBeNull();
    expect(blocks.script).toBeNull();
    expect(blocks.style).toBeNull();
  });

  it("reports correct 1-indexed line numbers for each block's inner content", () => {
    // Lines:
    //   1: <template>
    //   2:   <h1>hi</h1>
    //   3: </template>
    //   4: (blank)
    //   5: <script>
    //   6: const x = 1
    //   7: </script>
    const sfc = `<template>
  <h1>hi</h1>
</template>

<script>
const x = 1
</script>
`;
    const blocks = parseSFCBlocks(sfc);
    expect(blocks.template!.startLine).toBe(2);
    expect(blocks.script!.startLine).toBe(6);
  });

  it("recognises lang attribute case-insensitively", () => {
    const sfc = `<script LANG="TS">const x: number = 1</script>`;
    const blocks = parseSFCBlocks(sfc);
    expect(blocks.script!.lang).toBe("ts");
  });

  it("handles attributes in any order around lang/setup", () => {
    const sfc = `<script setup lang="ts">const x = 1</script>`;
    const blocks = parseSFCBlocks(sfc);
    expect(blocks.script!.setup).toBe(true);
    expect(blocks.script!.lang).toBe("ts");
  });
});

describe("extractComponentRefs", () => {
  it("extracts unique PascalCase tags from a template", () => {
    const template = `
      <UserCard :user="user" />
      <BaseButton variant="primary">Click</BaseButton>
      <UserCard :user="other" />
      <div>plain html</div>
    `;
    const refs = extractComponentRefs(template);
    expect(refs.sort()).toEqual(["BaseButton", "UserCard"]);
  });

  it("ignores lowercase HTML tags", () => {
    const template = `<div><span><p><a href="x">link</a></p></span></div>`;
    expect(extractComponentRefs(template)).toEqual([]);
  });

  it("handles self-closing and unclosed-on-purpose tags", () => {
    const template = `<UserCard /><BaseAvatar`;
    expect(extractComponentRefs(template).sort()).toEqual(["BaseAvatar", "UserCard"]);
  });
});

describe("parseVue — full SFC", () => {
  it("extracts a Composition API component with imports, refs, and template components", () => {
    const sfc = `<template>
  <UserCard :user="currentUser" @click="handleClick">
    <BaseAvatar :src="currentUser.avatar" />
  </UserCard>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { User } from './types'
import UserCard from './UserCard.vue'
import BaseAvatar from './ui/BaseAvatar.vue'

const currentUser = ref<User | null>(null)

function handleClick() {
  console.log('clicked')
}

const fullName = computed(() => currentUser.value?.name ?? '')
</script>

<style scoped>
.user { padding: 1rem; }
</style>
`;
    const result = parseVue(sfc, sfc.split("\n"));

    // Imports from script
    const importSources = result.imports.map((i) => i.source);
    expect(importSources).toContain("vue");
    expect(importSources).toContain("./types");
    expect(importSources).toContain("./UserCard.vue");
    expect(importSources).toContain("./ui/BaseAvatar.vue");

    // Component refs from template (treated as relative imports)
    expect(importSources).toContain("./UserCard");
    expect(importSources).toContain("./BaseAvatar");

    // Symbols from script
    const chunkNames = result.chunks.map((c) => c.name);
    expect(chunkNames).toContain("handleClick");
    // computed and ref are arrow expressions assigned to const; the
    // existing TS parser picks these up as functions when they have
    // arrow-function form. fullName uses `=>` so it's captured.
    expect(chunkNames).toContain("fullName");

    // Template chunk emitted
    expect(chunkNames).toContain("template");
  });

  it("remaps script chunk line numbers back to .vue file source lines", () => {
    // Template takes lines 1-3, blank line 4, script starts at line 5.
    // The function definition is on line 7 of the .vue file (line 3
    // within the script block, which itself starts at line 6 inside
    // the script tag's content).
    const sfc = `<template>
  <p>hi</p>
</template>

<script setup>
const a = 1
function greet() { return 'hi' }
</script>
`;
    const result = parseVue(sfc, sfc.split("\n"));
    const greet = result.chunks.find((c) => c.name === "greet");
    expect(greet).toBeDefined();
    // The line `function greet() { ... }` is line 7 in the .vue file
    // (1: <template>, 2: <p>, 3: </template>, 4: blank, 5: <script setup>,
    // 6: const a = 1, 7: function greet, 8: </script>).
    expect(greet!.startLine).toBe(7);
    expect(greet!.endLine).toBe(7);
  });

  it("works with Options API (export default)", () => {
    const sfc = `<template>
  <div>hi</div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'MyComponent',
  data() {
    return { count: 0 }
  },
})

export class Helper {
  greet() { return 'hi' }
}
</script>
`;
    const result = parseVue(sfc, sfc.split("\n"));
    const importSources = result.imports.map((i) => i.source);
    expect(importSources).toContain("vue");

    const chunkNames = result.chunks.map((c) => c.name);
    expect(chunkNames).toContain("Helper");
    expect(chunkNames).toContain("template");
  });

  it("handles a template-only SFC (no script) with a fallback chunk", () => {
    const sfc = `<template>
  <div>no script here</div>
</template>
`;
    const result = parseVue(sfc, sfc.split("\n"));
    // Template chunk should still be emitted.
    const names = result.chunks.map((c) => c.name);
    expect(names).toContain("template");
  });

  it("falls back to a whole-file chunk when no recognizable blocks exist", () => {
    const sfc = `not really a vue file at all`;
    const result = parseVue(sfc, sfc.split("\n"));
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].name).toBe("vue");
    expect(result.chunks[0].content).toBe(sfc);
  });

  it("captures TypeScript imports and types from script blocks", () => {
    const sfc = `<script setup lang="ts">
import { defineProps } from 'vue'
import type { ButtonVariant } from './types'

interface Props {
  variant: ButtonVariant
  disabled?: boolean
}

const props = defineProps<Props>()
</script>

<template>
  <button :disabled="props.disabled">click</button>
</template>
`;
    const result = parseVue(sfc, sfc.split("\n"));
    const importSources = result.imports.map((i) => i.source);
    expect(importSources).toContain("vue");
    expect(importSources).toContain("./types");

    const chunkNames = result.chunks.map((c) => c.name);
    expect(chunkNames).toContain("Props");
  });
});
