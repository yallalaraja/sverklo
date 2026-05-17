# Sverklo Demo v2 — 60-second walkthrough.
# Outputs both GIF (for embeds) and MP4 (for YouTube/LinkedIn).
# Records against /tmp/express-demo (Express.js, pre-cloned + indexed
# off-camera so the cold-start delay isn't on screen). Sverklo is
# already installed globally — we don't show npm install because it
# takes 24 seconds and would dominate a 60-second demo.

Output docs/demo-v2.gif
Output docs/demo-v2.mp4
Set FontSize 16
Set Width 1280
Set Height 720
Set Theme "Dracula"
Set Padding 24
Set TypingSpeed 28ms
Set Shell "zsh"

# ── Setup (hidden) ──────────────────────────────────────────────
Hide
Type "setopt interactive_comments"
Enter
Type "export PS1='$ '"
Enter
Type "cd /tmp/express-demo"
Enter
Type "clear"
Enter
Sleep 300ms
Show

# ── Scene 1: auto-config (8s) ───────────────────────────────────
Type "# Sverklo: local-first MCP code intelligence — auto-config any AI agent"
Enter
Sleep 800ms
Type "sverklo init"
Enter
Sleep 5500ms

# ── Scene 2: lint your codebase (16s) ──────────────────────────
Type "clear"
Enter
Sleep 200ms
Type "# Lint your codebase for AI-readiness — A-F grade in one call"
Enter
Sleep 800ms
Type "sverklo audit | head -28"
Enter
Sleep 12s

# ── Scene 3: shareable A-F badge (8s) ──────────────────────────
Type "clear"
Enter
Sleep 200ms
Type "# Pin the grade on your README — auto-updates from sverklo audit"
Enter
Sleep 800ms
Type "sverklo audit --badge"
Enter
Sleep 5s

# ── Scene 4: 37 MCP tools the agent calls (10s) ────────────────
Type "clear"
Enter
Sleep 200ms
Type "# Inside Claude Code / Cursor: 37 MCP tools the agent uses"
Enter
Sleep 800ms
Type "sverklo --help | head -16"
Enter
Sleep 7s

# ── Scene 5: closing CTA (5s) ──────────────────────────────────
Type "clear"
Enter
Sleep 200ms
Type "# Honest 60-task bench: https://sverklo.com/bench"
Enter
Sleep 600ms
Type "# 62× fewer tokens than naive grep · MIT · runs on your laptop"
Enter
Sleep 600ms
Type "# npm install -g sverklo && sverklo init"
Enter
Sleep 3s
