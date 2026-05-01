#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "Run this from inside the codex-phantom git repository." >&2
  exit 1
fi

cd "$repo_root"

source_root=".claude/skills"
dest_root=".agents/skills"
sync_dirs=("generated" "gitnexus")

echo "Running GitNexus analysis with skills and embeddings..."
npx gitnexus analyze --skills --embeddings "$@"

for dir in "${sync_dirs[@]}"; do
  if [ ! -d "$source_root/$dir" ]; then
    echo "Expected $source_root/$dir to exist after GitNexus analysis." >&2
    exit 1
  fi
done

mkdir -p "$dest_root"

tmp_root="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

for dir in "${sync_dirs[@]}"; do
  cp -R "$source_root/$dir" "$tmp_root/$dir"
done

for dir in "${sync_dirs[@]}"; do
  rm -rf "$dest_root/$dir"
  cp -R "$tmp_root/$dir" "$dest_root/$dir"
  echo "Synced $source_root/$dir -> $dest_root/$dir"
done

echo "GitNexus index and Codex skills are current."
