# sverklo agents

Drop-in subagent definitions for AI coding clients that support the [Claude Code subagent format](https://code.claude.com/docs/en/sub-agents) (markdown with YAML frontmatter).

## Available

### [sverklo-explore.md](./sverklo-explore.md)

Replaces Claude Code's built-in `Explore` subagent with sverklo's typed MCP tools. One tool call per question, structured output, ~95% fewer tokens than the default Read + Grep cascade.

The default Explore subagent burns ~14,200 input tokens locating one function on a 200-file repo ([field study](https://sverklo.com/blog/14200-tokens-to-find-one-function/)). This subagent uses sverklo's hybrid retrieval (BM25 + ONNX embeddings + PageRank) and answers the same question in ~150-800 tokens.

## Installation

Copy the file into your project's `.claude/agents/` directory:

```bash
mkdir -p .claude/agents
curl -o .claude/agents/sverklo-explore.md \
  https://raw.githubusercontent.com/sverklo/sverklo/main/agents/sverklo-explore.md
```

Restart your IDE (or the MCP client). The subagent is now available — invoke by name: `Use sverklo-explore to find where parseConfig is defined.`

## Prereq

You need sverklo installed and the project indexed:

```bash
npm install -g sverklo
cd your-project
sverklo init
```

The subagent calls sverklo MCP tools (`sverklo_lookup`, `sverklo_refs`, `sverklo_deps`, `sverklo_overview`, `sverklo_impact`, `sverklo_search`, `sverklo_status`). If sverklo isn't running, the subagent returns control with an install message rather than falling back to grep.

## Why ship subagents?

[Claude Code subagent traffic doubled in May 2026](https://nimbalyst.com/blog/claude-code-subagents-guide/) but the orchestration cost is ~7× tokens vs. monolithic agents. The bottleneck is exactly what sverklo's typed MCP tools optimize: precision per tool call. Tools-per-task on our [bench](https://sverklo.com/mcp/) is 1.0 for sverklo vs 6.1 for naive grep — the asymmetry compounds across subagent calls.

If you build a useful subagent definition that calls sverklo, open a PR adding it here.
