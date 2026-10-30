#!/usr/bin/env bash
# Run one hill-climb round of the Projection multi-server flow and export it.
#
#   .claude/hillclimb/multi-server/run-round.sh <variant> [phase ...] [--approve-harness]
#
# Phases (default: multi guard):
#   multi   train + tracked: multi tier, projection + projection-boxes,
#           haiku45 + sonnet-low, 3 reps (204 episodes), with the host's box
#           descriptions on (PROJ_EVAL_BOX_DESCRIPTIONS=1), as an integrator
#           would configure the facade (harness-change-2.md)
#   guard   held-out guard: basic,hard,filesystem,mongodb through projection,
#           both models, 1 rep (120 episodes)
#   direct  reference only: multi tier, direct mode, both models, 3 reps
#
# Each phase is one invocation of the live tool-choice test (the test's own
# 30-minute timeout covers a phase: ~10 min measured for multi). The raw
# harness JSON is copied to <variant>/raw/<phase>.json and must record the
# phase's harness flags (boxDescriptions as set below; outputSchemas true, the
# recording proxy mirroring the real servers' output schemas); a phase whose raw file
# already holds every planned episode is skipped, so a re-run resumes at phase
# granularity. Then export.mjs writes results.jsonl / errors.jsonl / traces /
# summary.json.
#
# Gates before any spend:
#   - harness integrity: sha256 over _state.json.harness_paths + pnpm-lock.yaml
#     must equal _state.json.harness_sha (exit 2 otherwise). Only the user
#     passes --approve-harness, which records the current hash.
#   - scope: every cell x tier needs a cost basis - observed, a pilot, the
#     phase's prior, or (multi-hard) $1/episode at list price (exit 5
#     otherwise: run a pilot); the resolved episode count must equal the
#     approved plan (_state.json.phases.<phase>.episodes; exit 4), and spend
#     so far plus the phase estimate must stay under _state.json.budget_usd
#     (exit 3).
set -euo pipefail

FLOW="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$FLOW/../../.." && pwd)"
STATE="$FLOW/_state.json"

APPROVE=0
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--approve-harness" ]]; then APPROVE=1; else ARGS+=("$a"); fi
done
VARIANT="${ARGS[0]:-}"
if [[ -z "$VARIANT" || "$VARIANT" == */* || "$VARIANT" == .* ]]; then
  echo "usage: run-round.sh <variant> [multi] [guard] [direct] [--approve-harness]" >&2
  exit 1
fi
PHASES=("${ARGS[@]:1}")
if [[ ${#PHASES[@]} -eq 0 ]]; then PHASES=(multi guard); fi
VDIR="$FLOW/$VARIANT"
mkdir -p "$VDIR/raw"

# --- harness integrity gate -------------------------------------------------
HASH="$(cd "$REPO" && node -e '
const fs = require("fs"), crypto = require("crypto");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const h = crypto.createHash("sha256");
for (const p of [...s.harness_paths, "pnpm-lock.yaml"]) { h.update(p + "\0"); h.update(fs.readFileSync(p)); h.update("\0"); }
process.stdout.write(h.digest("hex"));' "$STATE")"
RECORDED="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).harness_sha ?? "")' "$STATE")"
if [[ $APPROVE -eq 1 ]]; then
  node -e '
const fs = require("fs"); const p = process.argv[1];
const s = JSON.parse(fs.readFileSync(p, "utf8")); s.harness_sha = process.argv[2];
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");' "$STATE" "$HASH"
  echo "harness approved: $HASH"
elif [[ "$HASH" != "$RECORDED" ]]; then
  echo "STOP: harness files changed since the last --approve-harness (recorded ${RECORDED:-none}, now $HASH)." >&2
  echo "Review the diff of _state.json.harness_paths, then the user re-runs with --approve-harness." >&2
  exit 2
fi

# --- build the library the harness imports (dist) ---------------------------
(cd "$REPO" && pnpm --silent --filter @astral-mcp/projection build >/dev/null)

phase_env() {
  local base="PROJ_LIVE_EVAL=1 PROJ_EVAL_MODELS=haiku45,sonnet-low PROJ_EVAL_CONCURRENCY=4"
  case "$1" in
    multi) echo "$base PROJ_EVAL_TIERS=multi PROJ_EVAL_MODES=projection,projection-boxes PROJ_EVAL_RUNS=3 PROJ_EVAL_BOX_DESCRIPTIONS=1" ;;
    guard) echo "$base PROJ_EVAL_TIERS=basic,hard,filesystem,mongodb PROJ_EVAL_MODES=projection PROJ_EVAL_RUNS=1" ;;
    direct) echo "$base PROJ_EVAL_TIERS=multi PROJ_EVAL_MODES=direct PROJ_EVAL_RUNS=3" ;;
    *) echo "unknown phase $1" >&2; return 1 ;;
  esac
}

for PHASE in "${PHASES[@]}"; do
  ENVS="$(phase_env "$PHASE")"
  SCOPE="$VDIR/raw/.scope-$PHASE.json"
  (cd "$REPO" && env -u PROJ_EVAL_TASKS -u PROJ_EVAL_BOX_DESCRIPTIONS $ENVS \
    pnpm --silent --filter @astral-mcp/harness exec unrun "$FLOW/scope.ts") >"$SCOPE"
  PLANNED="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).episodes))' "$SCOPE")"
  RAW="$VDIR/raw/$PHASE.json"
  if [[ -f "$RAW" ]]; then
    HAVE="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).records.length))' "$RAW")"
    if [[ "$HAVE" == "$PLANNED" ]]; then
      echo "phase $PHASE: $RAW already complete ($HAVE/$PLANNED) - skipping"
      continue
    fi
    echo "phase $PHASE: $RAW partial ($HAVE/$PLANNED) - re-running the phase"
    mv "$RAW" "$VDIR/raw/.partial-$PHASE-$(date +%s).json.bak"
  fi
  node "$FLOW/export.mjs" scope "$FLOW" "$PHASE" "$SCOPE"

  LOG="$VDIR/raw/$PHASE.log"
  RESULTS_DIR="$REPO/packages/harness/eval-results"
  mkdir -p "$RESULTS_DIR"
  MARK="$VDIR/raw/.start-$PHASE"
  touch "$MARK"
  sleep 1
  echo "phase $PHASE: running $PLANNED episodes ($ENVS); log $LOG"
  # PROJ_EVAL_BATCH=1 from the caller: run the phase through the Message Batches API.
  BATCH_ENV=""
  if [[ "${PROJ_EVAL_BATCH:-}" == "1" ]]; then BATCH_ENV="PROJ_EVAL_BATCH=1"; fi
  set +e
  (cd "$REPO" && env -u PROJ_EVAL_TASKS -u PROJ_EVAL_BOX_DESCRIPTIONS -u PROJ_EVAL_BATCH $ENVS $BATCH_ENV \
    pnpm --filter @astral-mcp/harness exec vitest run test/tool-choice.live.test.ts) >"$LOG" 2>&1
  STATUS=$?
  set -e
  # The harness names its results file by start time; take the newest one
  # created after this phase started (vitest may not echo the path).
  RESULTS="$(node -e '
const fs = require("fs"), path = require("path");
const [dir, mark] = process.argv.slice(1);
const since = fs.statSync(mark).mtimeMs;
const hits = fs.readdirSync(dir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".rescored.json"))
  .map((f) => path.join(dir, f))
  .filter((f) => fs.statSync(f).mtimeMs > since)
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
process.stdout.write(hits[0] ?? "");' "$RESULTS_DIR" "$MARK")"
  if [[ -z "$RESULTS" || ! -f "$RESULTS" ]]; then
    echo "phase $PHASE: no results file (vitest exit $STATUS); see $LOG" >&2
    tail -30 "$LOG" >&2
    exit 1
  fi
  # The results must say they ran under this phase's harness flags; a mismatch is
  # not adopted as the phase's raw file.
  WANT_BOXES=false
  if [[ "$ENVS" == *"PROJ_EVAL_BOX_DESCRIPTIONS=1"* ]]; then WANT_BOXES=true; fi
  FLAGS="$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(`${r.boxDescriptions === true} ${r.outputSchemas === true}`);' "$RESULTS")"
  if [[ "$FLAGS" != "$WANT_BOXES true" ]]; then
    echo "phase $PHASE: results flags (boxDescriptions outputSchemas) are '$FLAGS', expected '$WANT_BOXES true'" >&2
    exit 1
  fi
  cp "$RESULTS" "$RAW"
  HAVE="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).records.length))' "$RAW")"
  echo "phase $PHASE: vitest exit $STATUS, $HAVE/$PLANNED episodes -> $RAW"
  if [[ "$HAVE" != "$PLANNED" ]]; then
    echo "phase $PHASE: short ($HAVE/$PLANNED); re-run the same command to retry this phase" >&2
    node "$FLOW/export.mjs" export "$VDIR"
    exit 1
  fi
done

node "$FLOW/export.mjs" export "$VDIR"
node "$FLOW/export.mjs" spend "$FLOW"
