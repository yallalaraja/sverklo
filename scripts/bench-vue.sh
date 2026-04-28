#!/usr/bin/env bash
# Smoke test for Vue.js (.vue) support against the top 5 Vue codebases.
# Pin versions so the test is reproducible. Reports per-repo:
#   - .vue file count, parse errors, symbol count, import edges, time
#
# Run with: bash scripts/bench-vue.sh

set -uo pipefail

CACHE="${SVERKLO_VUE_BENCH_CACHE:-$HOME/.sverklo/bench-vue-cache}"
SVERKLO="${SVERKLO_BIN:-$(pwd)/dist/bin/sverklo.js}"
RESULTS="${RESULTS_FILE:-/tmp/bench-vue-results.txt}"

# repo = "owner/repo@tag"
REPOS=(
  "vuetifyjs/vuetify@v3.7.6"
  "element-plus/element-plus@2.9.1"
  "vbenjs/vue-vben-admin@v5.5.4"
  "nuxt/nuxt@v3.15.0"
  "naive-ui/naive-ui@v2.40.4"
)

mkdir -p "$CACHE"
: > "$RESULTS"

printf '%-30s %8s %12s %10s %10s %10s %8s\n' \
  REPO TAG VUE_FILES ERRORS CHUNKS IMPORTS SECS \
  | tee -a "$RESULTS"
echo "-----------------------------------------------------------------------------" | tee -a "$RESULTS"

for entry in "${REPOS[@]}"; do
  repo="${entry%@*}"
  tag="${entry#*@}"
  name="$(basename "$repo")-$tag"
  dir="$CACHE/$name"

  if [ ! -d "$dir/.git" ]; then
    echo ">> cloning $repo @ $tag" >&2
    git clone --depth 1 --branch "$tag" "https://github.com/$repo.git" "$dir" 2>&1 \
      | tail -3 >&2 || { echo "$repo CLONE_FAIL" | tee -a "$RESULTS"; continue; }
  else
    echo ">> using cached $name" >&2
  fi

  vue_files=$(find "$dir" -type f -name "*.vue" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$vue_files" -eq 0 ]; then
    printf '%-30s %8s %12s %10s %10s %10s %8s\n' "$repo" "$tag" "$vue_files" "n/a" "n/a" "n/a" "skip" \
      | tee -a "$RESULTS"
    continue
  fi

  start=$(python3 -c "import time;print(time.time())")
  out_file="/tmp/sverklo-vue-$$-$name.log"
  ( cd "$dir" && SVERKLO_TELEMETRY=off node "$SVERKLO" index . 2>&1 ) > "$out_file" || true
  end=$(python3 -c "import time;print(time.time())")
  secs=$(python3 -c "print(f'{$end - $start:.1f}')")

  errors=$(grep -ciE "error|failed to (index|parse)" "$out_file" || echo 0)

  # Pull stats from sverklo's own DB. Use the same hashing logic as
  # src/utils/config.ts (sha256 of rootPath, first 12 chars).
  hash=$(node -e "console.log(require('crypto').createHash('sha256').update('$dir').digest('hex').slice(0,12))")
  db="$HOME/.sverklo/$(basename "$dir")-$hash/index.db"

  if [ -f "$db" ]; then
    chunks=$(sqlite3 "$db" "SELECT COUNT(*) FROM chunks WHERE file_id IN (SELECT id FROM files WHERE language='vue');" 2>/dev/null || echo "?")
    imports=$(sqlite3 "$db" "SELECT COUNT(*) FROM file_imports fi JOIN files f ON f.id=fi.file_id WHERE f.language='vue';" 2>/dev/null || echo "?")
  else
    chunks="no-db"
    imports="no-db"
  fi

  printf '%-30s %8s %12s %10s %10s %10s %8s\n' "$repo" "$tag" "$vue_files" "$errors" "$chunks" "$imports" "$secs" \
    | tee -a "$RESULTS"
done

echo
echo "Full per-repo logs in /tmp/sverklo-vue-*.log"
echo "Cache: $CACHE"
echo "Results: $RESULTS"
