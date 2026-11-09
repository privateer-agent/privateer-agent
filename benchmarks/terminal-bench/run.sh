#!/usr/bin/env bash
# Benchmark the released Privateer CLI on Terminal-Bench through Harbor. See README.md.
#
#   ./run.sh setup                 install Harbor, fetch the release, start the VM
#   ./run.sh oracle [task...]      run reference solutions, proving tasks can pass here (free)
#   ./run.sh agent [task...]       run Privateer (billed); no tasks = pilot-tasks.txt
#   ./run.sh report <job>          print the report for a finished job
set -euo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -P "$HERE/../.." && pwd)"
VENV="$HERE/.venv"
CACHE="$HERE/.cache"
JOBS="$HERE/jobs"

DATASET="${TB_DATASET:-terminal-bench@2.0}"
MODEL="${TB_MODEL:-privateer/openai/gpt-5.5}"
MIN_FREE_GB="${TB_MIN_FREE_GB:-4}"
MIN_START_GB="${TB_MIN_START_GB:-8}"
VM_MEMORY_GB="${TB_VM_MEMORY_GB:-6}"
VM_DISK_GB="${TB_VM_DISK_GB:-16}"
JOB_NAME="${TB_JOB:-}"

VERSION="$(node -p "require('$REPO/package.json').version")"
export PRIVATEER_BUNDLE="${PRIVATEER_BUNDLE:-$CACHE/privateer-linux-x64-$VERSION.tar.gz}"
# Published results are x86-64, and the linux-x64 bundle is the build users download.
export DOCKER_DEFAULT_PLATFORM=linux/amd64

is_mac() { [ "$(uname -s)" = Darwin ]; }
free_gb() { df -Pk "$HOME" | awk 'NR==2 { print int($4 / 1048576) }'; }

ensure_harbor() {
  [ -x "$VENV/bin/harbor" ] && return
  uv venv --python 3.12 "$VENV"
  VIRTUAL_ENV="$VENV" uv pip install -r "$HERE/requirements.txt"
}

ensure_bundle() {
  [ -f "$PRIVATEER_BUNDLE" ] && return
  local tmp
  tmp="$(mktemp -d)"
  gh release download "v$VERSION" -R privateer-agent/privateer-agent -D "$tmp" \
    -p privateer-linux-x64.tar.gz -p privateer-linux-x64.tar.gz.sha256
  (cd "$tmp" && shasum -a 256 -c privateer-linux-x64.tar.gz.sha256)
  mkdir -p "$(dirname "$PRIVATEER_BUNDLE")"
  mv "$tmp/privateer-linux-x64.tar.gz" "$PRIVATEER_BUNDLE"
  rm -rf "$tmp"
}

# Verifiers download uv and Python from astral-sh releases while scoring. A GitHub edge
# that intermittently 504s those downloads leaves work ungraded, so if the nearest edge
# is unreliable, redirect it to one that isn't. Inside the VM only; TLS still verifies.
github_edge_is_reliable() {
  local ip="$1" url code i
  local uv_url=https://github.com/astral-sh/uv/releases/download/0.9.5/uv-x86_64-unknown-linux-gnu.tar.gz
  local py_url=https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.13.9%2B20251014-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz
  for i in 1 2 3 4 5 6; do
    for url in "$uv_url" "$py_url"; do
      code="$(curl -sS -L -o /dev/null -r 0-1023 --max-time 60 \
        --resolve "github.com:443:$ip" -w '%{http_code}' "$url" 2>/dev/null || true)"
      case "$code" in 200 | 206) ;; *) return 1 ;; esac
    done
  done
}

route_around_bad_github_edge() {
  local nearest candidate
  nearest="$(dig +short github.com | tail -1)"
  if github_edge_is_reliable "$nearest"; then
    echo "GitHub edge $nearest is reliable."
    return
  fi
  for candidate in 20.27.177.113 140.82.112.3 140.82.114.3; do
    if github_edge_is_reliable "$candidate"; then
      colima ssh -- sudo iptables -t nat -C PREROUTING -d "$nearest/32" -p tcp --dport 443 \
        -j DNAT --to-destination "$candidate" 2>/dev/null ||
        colima ssh -- sudo iptables -t nat -I PREROUTING -d "$nearest/32" -p tcp --dport 443 \
          -j DNAT --to-destination "$candidate"
      echo "GitHub edge $nearest is unreliable; using $candidate inside the VM."
      return
    fi
  done
  echo "WARNING: no reliable GitHub edge found; verifiers may fail to start." >&2
}

ensure_runtime() {
  is_mac || return 0
  colima status >/dev/null 2>&1 || colima start --vm-type vz --vz-rosetta \
    --cpu 6 --memory "$VM_MEMORY_GB" --disk "$VM_DISK_GB"
  route_around_bad_github_edge
}

require_disk_room() {
  local free
  free="$(free_gb)"
  [ "$free" -ge "$MIN_START_GB" ] && return
  echo "Not starting: $free GB free, need at least $MIN_START_GB GB." >&2
  return 1
}

# Container layers are freed inside the VM but its disk image only shrinks on trim, so
# without this a run can fill the Mac. Trim steadily and stop before the disk is full.
disk_guard() {
  local harbor_pid="$1" job_dir="$2" ids
  while kill -0 "$harbor_pid" 2>/dev/null; do
    sleep 20
    is_mac && colima ssh -- sudo fstrim -a >/dev/null 2>&1 || true
    if [ "$(free_gb)" -lt "$MIN_FREE_GB" ]; then
      echo "Disk guard: under $MIN_FREE_GB GB free, stopping the run." >&2
      mkdir -p "$job_dir" && touch "$job_dir/.disk-guard-stopped"
      kill -TERM "$harbor_pid" 2>/dev/null || true
      sleep 20
      ids="$(docker ps -aq --filter label=com.docker.compose.project)"
      [ -z "$ids" ] || docker rm -f $ids >/dev/null
      return
    fi
  done
}

pilot_tasks() { grep -v -E '^(#|$)' "$HERE/pilot-tasks.txt"; }

# Deletes only images that appeared since the snapshot, so a machine's own are safe.
remove_images_pulled_since() {
  local new
  new="$(comm -13 <(printf '%s\n' "$1") <(docker images -q | sort -u))"
  [ -z "$new" ] || docker image rm -f $new >/dev/null 2>&1 || true
}

# One task is one Harbor job, and its image goes when it finishes, so the disk only ever
# holds one task. Returns non-zero if the disk guard stopped it: nothing may follow.
run_task() {
  local job_dir="$1" task="$2" rc=0 pid guard images_before
  images_before="$(docker images -q | sort -u)"
  (
    cd "$JOBS"
    exec env PYTHONPATH="$HERE" "$VENV/bin/harbor" run -d "$DATASET" -n 1 \
      -o "$job_dir" --job-name "$task" --quiet -i "*$task" "${HARBOR_ARGS[@]}" </dev/null
  ) &
  pid=$!
  disk_guard "$pid" "$job_dir" &
  guard=$!
  wait "$pid" || rc=$?
  kill "$guard" 2>/dev/null || true
  wait "$guard" 2>/dev/null || true
  [ -n "${TB_KEEP_IMAGES:-}" ] || remove_images_pulled_since "$images_before"
  is_mac && colima ssh -- sudo fstrim -a >/dev/null 2>&1 || true
  [ "$rc" -eq 0 ] || echo "Harbor exited with $rc on $task" >&2
  [ ! -e "$job_dir/.disk-guard-stopped" ] && ! agent_never_started "$job_dir/$task"
}

# An agent that exits without taking a turn will do the same on every task, so stop
# rather than burn through the list. Oracle runs have no agent log and always pass this.
agent_never_started() {
  local exit_file
  for exit_file in "$1"/*/agent/privateer.exit; do
    [ -f "$exit_file" ] || continue
    [ "$(cat "$exit_file")" != 0 ] || continue
    if ! grep -q '"type":"turn_end"' "$(dirname "$exit_file")/privateer.jsonl" 2>/dev/null; then
      echo "Privateer exited without taking a turn on $(basename "$1"), stopping:" >&2
      grep -v -E 'No quarter|Every action|and outbound|Only use|shift\+tab|^$' \
        "$(dirname "$exit_file")/privateer.stderr.log" | head -6 >&2
      return 0
    fi
  done
  return 1
}

# Tasks that already finished under this job name are skipped, so an interrupted run
# resumes without paying for them twice.
run_tasks() {
  local job_dir="$JOBS/$1" task stopped=0
  shift
  mkdir -p "$job_dir"
  for task in "$@"; do
    if [ -f "$job_dir/$task/result.json" ]; then
      echo "Already finished: $task"
      continue
    fi
    if ! require_disk_room || ! run_task "$job_dir" "$task"; then
      stopped=1
      break
    fi
  done
  "$VENV/bin/python" -I "$HERE/report.py" "$job_dir"
  [ "$stopped" -eq 0 ]
}

command="${1:-}"
[ "$#" -eq 0 ] || shift

case "$command" in
  setup)
    ensure_harbor
    ensure_bundle
    ensure_runtime
    ;;
  oracle)
    require_disk_room
    ensure_harbor
    ensure_runtime
    [ "$#" -gt 0 ] || set -- $(pilot_tasks)
    HARBOR_ARGS=(-a oracle)
    run_tasks "${JOB_NAME:-oracle-$(date +%Y%m%d-%H%M%S)}" "$@"
    ;;
  agent)
    require_disk_room
    ensure_harbor
    ensure_bundle
    ensure_runtime
    [ "$#" -gt 0 ] || set -- $(pilot_tasks)
    HARBOR_ARGS=(--agent privateer_tb:PrivateerAgent -m "$MODEL")
    run_tasks "${JOB_NAME:-privateer-$(date +%Y%m%d-%H%M%S)}" "$@"
    ;;
  report)
    "$VENV/bin/python" -I "$HERE/report.py" "$JOBS/$1"
    ;;
  *)
    sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
