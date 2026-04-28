import { describe, it, expect } from "vitest";
import { parseTSJS } from "./parser.js";

describe("parseTSJS — import regex hardening (v0.18.1 hotfix)", () => {
  it("Finding 1: tolerates leading whitespace before `import` (Vue SFC indented script blocks)", () => {
    const content = `
  import { ref, computed } from 'vue'
  import UserCard from './UserCard.vue'
  import type { User } from './types'
`;
    const result = parseTSJS(content, content.split("\n"));
    const sources = result.imports.map((i) => i.source);
    expect(sources).toContain("vue");
    expect(sources).toContain("./UserCard.vue");
    expect(sources).toContain("./types");
  });

  it("Finding 1: tolerates tabs as well as spaces", () => {
    const content = "\timport { foo } from 'bar'\n";
    const result = parseTSJS(content, content.split("\n"));
    expect(result.imports[0]?.source).toBe("bar");
  });

  it("Finding 1: still works for unindented imports (regression check)", () => {
    const content = "import { foo } from 'bar'\nimport baz from 'qux'\n";
    const result = parseTSJS(content, content.split("\n"));
    expect(result.imports.map((i) => i.source).sort()).toEqual(["bar", "qux"]);
  });

  it("Finding 2: strips inline `type` keyword from named-import names", () => {
    // `import { type X, Y } from 'z'` is the Vue Composition API
    // canonical form. Without the `type` strip, X was stored as "type X".
    const content = `import { type Ref, ref } from 'vue'`;
    const result = parseTSJS(content, [content]);
    expect(result.imports[0].names).toEqual(["Ref", "ref"]);
  });

  it("Finding 2: handles multiple inline type keywords", () => {
    const content = `import { type A, type B, c, type D } from 'mod'`;
    const result = parseTSJS(content, [content]);
    expect(result.imports[0].names).toEqual(["A", "B", "c", "D"]);
  });

  it("Finding 10: parses default + named combo (`import X, { Y } from 'z'`)", () => {
    const content = `import React, { useState, useEffect } from 'react'`;
    const result = parseTSJS(content, [content]);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0].source).toBe("react");
    expect(result.imports[0].names).toEqual(["React", "useState", "useEffect"]);
  });

  it("Finding 10: default + type-only named combo", () => {
    const content = `import React, { type FC, useState } from 'react'`;
    const result = parseTSJS(content, [content]);
    expect(result.imports[0].names).toEqual(["React", "FC", "useState"]);
  });

  it("preserves `import type { X } from 'y'` (already covered, regression check)", () => {
    const content = `import type { ButtonVariant } from './types'`;
    const result = parseTSJS(content, [content]);
    expect(result.imports[0].source).toBe("./types");
    expect(result.imports[0].names).toEqual(["ButtonVariant"]);
  });

  it("preserves bare `import 'side-effect'` form (regression check)", () => {
    const content = `import 'core-js/stable'`;
    const result = parseTSJS(content, [content]);
    expect(result.imports[0].source).toBe("core-js/stable");
    expect(result.imports[0].names).toEqual([]);
  });

  it("strips `as` aliases from imported names (regression check)", () => {
    const content = `import { foo as bar, baz } from 'mod'`;
    const result = parseTSJS(content, [content]);
    expect(result.imports[0].names).toEqual(["foo", "baz"]);
  });
});
