"""Score a Harbor job directory and write report.md beside it.

Only trials whose tests actually ran count toward the pass rate. A verifier that never
reached its tests measured nothing about the agent, so it is reported as infrastructure.

usage: python -I report.py <job_dir>
"""

import datetime as dt
import json
import math
import pathlib
import ssl
import sys
import urllib.request

# tbench.ai Terminal-Bench 2.0 entries, snapshot of 2026-04-27 (via codesota.com).
PUBLISHED = (
    ("Codex + GPT-5.5", 82.0),
    ("ForgeCode + GPT-5.4", 81.8),
    ("ForgeCode + Claude Opus 4.6", 79.8),
    ("Droid + GPT-5.3-Codex", 77.3),
)
MAX_SCAN_BYTES = 200 * 1024 * 1024
LOGIN_PATH = pathlib.Path.home() / ".privateer" / "credentials.json"

# Account models report zero cost, so their charge is estimated from token counts. The
# catalog publishes provider rates; the server multiplies by a markup (default 2.15, a
# model can override it) and bills cached input at a provider rate the catalog omits.
MARKUP_FACTOR = 2.15
CACHED_INPUT_RATE_FRACTION = 0.1


def published_rates():
    """USD per token by model from the server's public catalog; empty if unreachable."""
    try:
        base_url = json.loads(LOGIN_PATH.read_text())["serverBaseUrl"]
        request = urllib.request.Request(
            f"{base_url}/api/models", headers={"User-Agent": "privateer-benchmark"}
        )
        with urllib.request.urlopen(request, timeout=30, context=ssl_context()) as response:
            models = json.load(response)["models"]
    except (OSError, ValueError, KeyError):
        return {}
    return {
        model["modelId"]: (model["ratePerInputToken"], model["ratePerOutputToken"])
        for model in models
        if model.get("ratePerInputToken") and model.get("ratePerOutputToken")
    }


def ssl_context():
    import certifi  # uv's standalone Python ships no CA bundle of its own

    return ssl.create_default_context(cafile=certifi.where())


def trial_cost(row, rates):
    """The CLI's figure when it has one, otherwise an estimate. None if neither exists."""
    if row["cost"] > 0:
        return row["cost"]
    if row["model"] not in rates:
        return None
    input_rate, output_rate = rates[row["model"]]
    fresh_input = row["input"] - row["cached"]
    weighted_input = fresh_input + row["cached"] * CACHED_INPUT_RATE_FRACTION
    return (weighted_input * input_rate + row["output"] * output_rate) * MARKUP_FACTOR


def seconds(span):
    try:
        start = dt.datetime.fromisoformat(span["started_at"].replace("Z", "+00:00"))
        end = dt.datetime.fromisoformat(span["finished_at"].replace("Z", "+00:00"))
    except (KeyError, TypeError, AttributeError, ValueError):
        return None
    return round((end - start).total_seconds())


def read_text(path):
    return path.read_text(errors="replace") if path.exists() else ""


def agent_activity(trial_dir):
    """Tool use and failure signals from the agent's own event stream."""
    activity = {"turns": 0, "tools": 0, "tool_errors": 0, "api_errors": [], "cost": 0.0}
    for line in read_text(trial_dir / "agent" / "privateer.jsonl").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind == "turn_end":
            activity["turns"] += 1
        elif kind == "tool_execution_end":
            activity["tools"] += 1
            activity["tool_errors"] += 1 if event.get("isError") else 0
        elif kind == "message_end":
            message = event.get("message") or {}
            if message.get("role") == "assistant":
                activity["cost"] += ((message.get("usage") or {}).get("cost") or {}).get("total", 0.0)
                if message.get("stopReason") == "error":
                    activity["api_errors"].append((message.get("errorMessage") or "error")[:200])
    return activity


def trial_row(path):
    result = json.loads(path.read_text())
    trial_dir = path.parent
    reward = ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    tests_ran = "test session starts" in read_text(trial_dir / "verifier" / "test-stdout.txt")
    agent = result.get("agent_result") or {}
    activity = agent_activity(trial_dir)
    exit_code = read_text(trial_dir / "agent" / "privateer.exit").strip()
    never_started = exit_code not in ("", "0") and activity["turns"] == 0
    outcome = (
        "pass" if reward == 1.0
        else "no-run" if never_started
        else "fail" if tests_ran
        else "infra"
    )
    model = ((result.get("agent_info") or {}).get("model_info") or {}).get("name") or ""
    return {
        "task": result.get("task_name", "?"),
        "model": model.removeprefix("privateer/"),
        "outcome": outcome,
        "exception": (result.get("exception_info") or {}).get("exception_type") or "",
        "exit": exit_code or "-",
        "seconds": seconds(result.get("agent_execution")),
        "input": agent.get("n_input_tokens") or 0,
        "cached": agent.get("n_cache_tokens") or 0,
        "output": agent.get("n_output_tokens") or 0,
        "cost": activity["cost"],
        **{key: activity[key] for key in ("turns", "tools", "tool_errors", "api_errors")},
    }


def wilson_interval(passed, total, z=1.96):
    if not total:
        return (0.0, 0.0)
    rate = passed / total
    denominator = 1 + z * z / total
    centre = rate + z * z / (2 * total)
    margin = z * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total))
    return (100 * (centre - margin) / denominator, 100 * (centre + margin) / denominator)


def login_leaks(job_dir):
    """Files containing this machine's login. The run must never persist it."""
    try:
        login = json.loads(LOGIN_PATH.read_text())
    except (OSError, ValueError):
        return []
    secrets = [login[key].encode() for key in ("accessToken", "refreshToken") if login.get(key)]
    return [
        str(path)
        for path in job_dir.rglob("*")
        if path.is_file()
        and path.stat().st_size < MAX_SCAN_BYTES
        and any(secret in path.read_bytes() for secret in secrets)
    ]


def render(job_dir, rows, leaks, rates):
    scored = [row for row in rows if row["outcome"] in ("pass", "fail")]
    passed = sum(row["outcome"] == "pass" for row in scored)
    low, high = wilson_interval(passed, len(scored))
    costs = [trial_cost(row, rates) for row in rows]

    lines = [f"# Terminal-Bench report: {job_dir.name}", ""]
    if scored:
        lines.append(
            f"**{passed}/{len(scored)} passed ({100 * passed / len(scored):.0f}%)**, "
            f"95% interval {low:.0f}-{high:.0f}%."
        )
    else:
        lines.append("**No trial reached its tests, so nothing was measured.**")
    infra = sum(row["outcome"] == "infra" for row in rows)
    if infra:
        lines.append(f"{infra} trial(s) never reached their tests and are excluded.")
    no_run = sum(row["outcome"] == "no-run" for row in rows)
    if no_run:
        lines.append(f"**{no_run} trial(s) where the agent exited without taking a turn.**")
    if (job_dir / ".disk-guard-stopped").exists():
        lines.append("**The disk guard stopped this run early.**")
    if leaks:
        lines.append(f"**WARNING: login found in {len(leaks)} file(s). Do not share this job.**")
        lines += [f"- `{leak}`" for leak in leaks]

    lines += [
        "",
        "| Task | Result | Exit | Agent s | Turns | Tools (err) | Input (cached) | Output | Cost |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for row, cost in zip(rows, costs):
        result = row["outcome"] + (f" ({row['exception']})" if row["exception"] else "")
        cost_text = "unknown" if cost is None else f"${cost:.2f}"
        lines.append(
            f"| {row['task']} | {result} | {row['exit']} | {row['seconds']} | {row['turns']} "
            f"| {row['tools']} ({row['tool_errors']}) | {row['input']:,} ({row['cached']:,}) "
            f"| {row['output']:,} | {cost_text} |"
        )
    known = [cost for cost in costs if cost is not None]
    if known:
        lines += [
            "",
            f"Estimated charge: ${sum(known):.2f} across {len(known)} trial(s), from token "
            f"counts, published rates and a {MARKUP_FACTOR}x markup. Your account's usage "
            "history has the actual figure.",
        ]

    errors = [(row["task"], error) for row in rows for error in row["api_errors"]]
    if errors:
        lines += ["", "## Model API errors"] + [f"- {task}: {error}" for task, error in errors[:20]]

    lines += ["", "## Published Terminal-Bench 2.0 entries (all 89 tasks)", ""]
    lines += [f"- {name}: {score}%" for name, score in PUBLISHED]
    lines += ["", "A subset of tasks is not directly comparable to these full-benchmark scores."]
    return "\n".join(lines) + "\n"


def main():
    job_dir = pathlib.Path(sys.argv[1])
    rows = [
        trial_row(path)
        for path in sorted(job_dir.rglob("result.json"))
        if "task_name" in json.loads(path.read_text())  # job-level summaries have none
    ]
    report = render(job_dir, rows, login_leaks(job_dir), published_rates())
    (job_dir / "report.md").write_text(report)
    print(report)


if __name__ == "__main__":
    main()
