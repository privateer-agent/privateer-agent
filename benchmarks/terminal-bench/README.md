# Terminal-Bench for Privateer

Runs the released Privateer CLI on [Terminal-Bench](https://tbench.ai) through
[Harbor](https://github.com/harbor-framework/harbor), the same harness other CLI agents
publish their scores on.

## Run it

Needs `uv`, `node`, `gh`, a signed-in Privateer account and, on a Mac, `colima` and `docker`.

```bash
./run.sh setup              # install Harbor, fetch the release, start the VM
./run.sh oracle             # free: prove the pilot tasks can pass on this machine
./run.sh agent              # billed: run Privateer on pilot-tasks.txt
./run.sh agent build-pmars  # or name tasks
./run.sh report <job>       # reprint a report
```

Set `TB_JOB=<name>` to give a run a stable name. Rerunning under the same name skips tasks
that already finished, so an interrupted run resumes without paying for them twice.

| Variable | Default | Meaning |
|---|---|---|
| `TB_MODEL` | `privateer/openai/gpt-5.5` | Model to benchmark |
| `TB_DATASET` | `terminal-bench@2.0` | Harbor dataset |
| `PRIVATEER_BUNDLE` | the current release | A `linux-x64` tarball to test instead |
| `TB_MIN_START_GB` | `8` | Free disk required before each task starts |
| `TB_MIN_FREE_GB` | `4` | Free disk below which a running task is stopped |
| `TB_VM_MEMORY_GB`, `TB_VM_DISK_GB` | `6`, `16` | VM size on a Mac |
| `TB_KEEP_IMAGES` | unset | Keep each task's image instead of deleting it |
| `TB_THINKING` | the CLI's default | Reasoning level passed as `--thinking` (for comparing levels on the same tasks) |

To test an unreleased build:

```bash
node ../../scripts/build-bundle.mjs --target linux-x64
PRIVATEER_BUNDLE=../../dist-bundle/privateer-linux-x64.tar.gz TB_JOB=candidate ./run.sh agent
```

## Reading a report

Each job writes `jobs/<job>/report.md`.

- **pass / fail** are real grades: the task's tests ran.
- **infra** means the tests never started, usually a failed download. It says nothing about
  the agent, so it is left out of the pass rate. Rerun those tasks.
- **no-run** means the agent exited with an error before taking a single turn. It is left
  out of the pass rate and called out at the top of the report, because it points at a
  broken build or sign-in rather than a task the agent attempted.
- The **95% interval** is what the sample size supports. Ten tasks leave it very wide.
- **Published scores** are shown for context only unless you ran all 89 tasks.

## How the pilot sample is chosen

`pilot-tasks.txt` takes tasks in a fixed shuffle of the dataset (seed `20261109`), keeping
the first ten whose reference solution passes here. Membership depends only on the oracle,
never on how an agent scored, and tasks that cannot pass on this setup are listed there.

`holdout-tasks.txt` is the next ten from the same shuffle, chosen the same way. Fixes are
developed against the pilot, so the holdout is the sample that shows whether they generalize.
Run it with `./run.sh agent $(grep -v '^#' holdout-tasks.txt)`.

On Apple Silicon the x86-64 task images run under Rosetta, which cannot run everything, so a
Mac sample leans away from tasks that need `chroot` or QEMU. A score meant for comparison
should come from all 89 tasks on native x86-64 Linux.

## What the run does to your machine

- **The agent runs with `--no-quarter`** so it can work unattended. It is confined to a
  disposable container for each task.
- **Your login is copied into each container**, as files, so the agent can bill your account.
  It is not on a command line or in Harbor's logs, and each report warns if it finds it in a
  job's output. A task running unattended can still read it, so only run tasks you trust.
- **Disk** is protected by deleting each task's image afterwards, trimming the VM while tasks
  run, refusing to start below `TB_MIN_START_GB`, and stopping below `TB_MIN_FREE_GB`. Once a
  task is stopped for disk space, nothing else starts.
- **Delete everything** with `colima delete --force --data` and by removing `.venv`, `.cache`
  and `jobs`.
