#!/usr/bin/env bash
#
# wt.sh — worktree helper for the Turnstile git workflow (see CLAUDE.md §7).
#
#   wt.sh new  MOV-215 messari-subgraph
#       Creates ../turnstile-mov-215 on a new branch feat/mov-215-messari-subgraph
#       cut from dev, symlinks the root .env into it, and prints the cd command.
#
#   wt.sh done MOV-215
#       Pushes the branch to origin, merges it into dev with --no-ff in the main
#       worktree, and removes the worktree. The branch stays on the remote.
#
# --no-ff is hardcoded on purpose. A fast-forward flattens the feature boundary
# and destroys the per-feature history this whole workflow exists to produce.
# There is no flag to turn it off.

set -euo pipefail

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }

usage() {
  cat >&2 <<'USAGE'
usage:
  scripts/wt.sh new  <ISSUE-ID> <slug>   e.g. scripts/wt.sh new MOV-215 messari-subgraph
  scripts/wt.sh done <ISSUE-ID>          e.g. scripts/wt.sh done MOV-215
USAGE
  exit 2
}

# --- preconditions -----------------------------------------------------------

# Must be inside the repo, and specifically in the MAIN worktree, not a feature
# one — `done` merges into dev there, and `new` resolves ../turnstile-* from it.
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

MAIN_WT="$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')"
[ -n "$MAIN_WT" ] || die "could not determine the main worktree"

REPO_ROOT="$(git rev-parse --show-toplevel)"
[ "$REPO_ROOT" = "$MAIN_WT" ] || die "run this from the main worktree ($MAIN_WT), not from $REPO_ROOT"

[ "$PWD" = "$REPO_ROOT" ] || die "run this from the repo root: cd $REPO_ROOT"

[ -f "$REPO_ROOT/CLAUDE.md" ] && [ -d "$REPO_ROOT/scripts" ] \
  || die "$REPO_ROOT does not look like the turnstile repo root"

git show-ref --verify --quiet refs/heads/dev || die "branch 'dev' does not exist"

[ -n "${CARGO_TARGET_DIR:-}" ] || warn "CARGO_TARGET_DIR is unset — parallel Rust worktrees will each build from scratch. See .envrc.example"

# --- helpers -----------------------------------------------------------------

# MOV-215 -> mov-215
normalize_id() {
  local id="$1"
  printf '%s' "$id" | tr '[:upper:]' '[:lower:]'
}

require_dev_checked_out() {
  local head
  head="$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD || true)"
  [ "$head" = "dev" ] || die "the main worktree has '${head:-a detached HEAD}' checked out, not 'dev'. Run: git -C $REPO_ROOT switch dev"
}

# --- new ---------------------------------------------------------------------

cmd_new() {
  [ $# -eq 2 ] || usage
  local raw_id="$1" slug="$2"
  local id branch wt_path

  [[ "$raw_id" =~ ^[A-Za-z]+-[0-9]+$ ]] || die "issue id must look like MOV-215, got '$raw_id'"
  [[ "$slug"   =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "slug must be lowercase-kebab-case, got '$slug'"

  id="$(normalize_id "$raw_id")"
  branch="feat/${id}-${slug}"
  wt_path="$(dirname "$REPO_ROOT")/turnstile-${id}"

  git show-ref --verify --quiet "refs/heads/$branch" && die "branch $branch already exists"
  [ -e "$wt_path" ] && die "$wt_path already exists"

  info "worktree $wt_path on $branch (from dev)"
  git worktree add "$wt_path" -b "$branch" dev

  # .env is gitignored, so it does NOT follow the worktree. Symlink it or the
  # worktree fails at runtime.
  local linked=0
  local f
  for f in .env .envrc; do
    if [ -f "$REPO_ROOT/$f" ]; then
      ln -s "$REPO_ROOT/$f" "$wt_path/$f"
      info "symlinked $f"
      linked=1
    fi
  done
  [ "$linked" -eq 1 ] || warn "no .env or .envrc at $REPO_ROOT to symlink — copy .envrc.example first"

  printf '\n  cd %s\n\n' "$wt_path"
}

# --- done --------------------------------------------------------------------

cmd_done() {
  [ $# -eq 1 ] || usage
  local raw_id="$1" id wt_path branch

  [[ "$raw_id" =~ ^[A-Za-z]+-[0-9]+$ ]] || die "issue id must look like MOV-215, got '$raw_id'"

  id="$(normalize_id "$raw_id")"
  wt_path="$(dirname "$REPO_ROOT")/turnstile-${id}"

  [ -d "$wt_path" ] || die "no worktree at $wt_path — nothing to finish"

  branch="$(git -C "$wt_path" symbolic-ref --quiet --short HEAD || true)"
  [ -n "$branch" ] || die "$wt_path has a detached HEAD"
  [ "$branch" != "dev" ] && [ "$branch" != "main" ] || die "refusing to operate on '$branch'"

  # Nothing half-finished gets merged.
  [ -z "$(git -C "$wt_path" status --porcelain)" ] \
    || die "$wt_path has uncommitted changes — commit them first"

  require_dev_checked_out
  [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] \
    || die "the main worktree has uncommitted changes — commit or stash them first"

  git remote get-url origin >/dev/null 2>&1 \
    || die "no 'origin' remote. The feature branch must reach the remote — that push IS the history judges read"

  info "pushing $branch"
  git -C "$wt_path" push -u origin "$branch"

  # --no-ff, always. See the header comment.
  info "merging $branch into dev (--no-ff)"
  git -C "$REPO_ROOT" merge --no-ff "$branch" -m "merge: $branch"

  info "removing worktree $wt_path"
  git worktree remove "$wt_path"

  # Rule 5: feature branches stay on the remote after merging. Deleting them
  # deletes the history we are building. The local ref stays too.
  info "done. $branch is merged into dev and still on origin — do not delete it"
  git -C "$REPO_ROOT" --no-pager log --graph --oneline -5
}

# --- dispatch ----------------------------------------------------------------

[ $# -ge 1 ] || usage
sub="$1"; shift
case "$sub" in
  new)  cmd_new  "$@" ;;
  done) cmd_done "$@" ;;
  *)    usage ;;
esac
