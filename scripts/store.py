#!/usr/bin/env python3
"""Turn one workflow run's benchmark jobs into stored rows.

Usage:
  store.py collect --results DIR --out rows.json
      Reads every benchmark job of the current run attempt from the GitHub
      API (queue time = started_at - created_at) and joins it with the
      result file that job uploaded, if any. A job that never got a runner
      still becomes a row, with no scores.
  store.py append rows.json --data DIR
      Appends rows to DIR/runs/YYYY-MM.jsonl (skipping ones already stored)
      and rewrites DIR/index.json, the list of months the site loads.

Environment for collect: GITHUB_TOKEN (actions: read), GITHUB_REPOSITORY,
GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_API_URL.
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sys
import urllib.request

# Benchmark jobs are named "bench (<runner label>)" in cpu-benchmark.yml.
JOB_NAME = re.compile(r"^bench \((?P<label>[^)]+)\)$")


def api(path):
    base = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    req = urllib.request.Request(
        f"{base}{path}",
        headers={
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def run_jobs(repo, run_id, attempt):
    jobs, page = [], 1
    while True:
        data = api(f"/repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100&page={page}")
        jobs += data["jobs"]
        if len(jobs) >= data["total_count"] or not data["jobs"]:
            return jobs
        page += 1


def ts(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def seconds(start, end):
    if start and end:
        return max(0, round((ts(end) - ts(start)).total_seconds()))
    return None


def load_results(results_dir):
    """{label: result dict} from the artifacts (results/<artifact>/<label>.json)."""
    out = {}
    for path in sorted(pathlib.Path(results_dir).rglob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError) as exc:
            print(f"::warning::skipping {path}: {exc}")
            continue
        out[data.get("label") or path.stem] = data
    return out


def collect(results_dir, out):
    repo = os.environ["GITHUB_REPOSITORY"]
    run_id = int(os.environ["GITHUB_RUN_ID"])
    attempt = int(os.environ.get("GITHUB_RUN_ATTEMPT", "1"))
    results = load_results(results_dir)
    rows = []
    for job in run_jobs(repo, run_id, attempt):
        m = JOB_NAME.match(job["name"])
        if not m:
            continue
        label = m.group("label")
        result = results.pop(label, {})
        # A job cancelled before any runner picked it up has no runner_name;
        # its started_at is the cancellation time, not a start.
        started = job.get("started_at") if job.get("runner_name") else None
        row = {
            "created_at": job["created_at"],
            "started_at": started,
            "completed_at": job.get("completed_at"),
            "queue_seconds": seconds(job["created_at"], started),
            "label": label,
            "conclusion": job.get("conclusion") or job.get("status"),
            "run_id": run_id,
            "run_attempt": attempt,
            "job_id": job["id"],
            "url": job.get("html_url"),
            "runner_name": job.get("runner_name") or result.get("runner_name"),
        }
        for key, value in result.items():
            row.setdefault(key, value)
        rows.append(row)
    for label in results:
        print(f"::warning::result for {label} has no matching job in this run attempt")
    pathlib.Path(out).write_text(json.dumps(rows, indent=2) + "\n")
    for row in rows:
        queue = "-" if row["queue_seconds"] is None else f"{row['queue_seconds']}s"
        print(
            f"{row['label']:<28} queue={queue} cpu_mark={row.get('cpu_mark')} "
            f"single={row.get('single_thread')} cpu={row.get('cpu_model')!r} {row['conclusion']}"
        )
    return 0


def key(row):
    return (row["run_id"], row["run_attempt"], row["label"])


def append(rows_file, data_dir):
    rows = json.loads(pathlib.Path(rows_file).read_text())
    runs = pathlib.Path(data_dir) / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    added = 0
    for month in sorted({r["created_at"][:7] for r in rows}):
        path = runs / f"{month}.jsonl"
        seen = set()
        if path.exists():
            for line in path.read_text().splitlines():
                if line.strip():
                    seen.add(key(json.loads(line)))
        new = [r for r in rows if r["created_at"][:7] == month and key(r) not in seen]
        if new:
            with path.open("a") as f:
                for r in sorted(new, key=lambda r: (r["created_at"], r["label"])):
                    f.write(json.dumps(r, separators=(",", ":")) + "\n")
            added += len(new)
    months = sorted(p.stem for p in runs.glob("*.jsonl"))
    index_path = pathlib.Path(data_dir) / "index.json"
    if added or not index_path.exists():
        index = {
            "updated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "months": months,
        }
        index_path.write_text(json.dumps(index, indent=2) + "\n")
    print(f"added {added} row(s); {len(months)} month file(s)")
    return 0


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--results", required=True)
    c.add_argument("--out", required=True)
    a = sub.add_parser("append")
    a.add_argument("rows")
    a.add_argument("--data", required=True)
    args = parser.parse_args()
    if args.cmd == "collect":
        return collect(args.results, args.out)
    return append(args.rows, args.data)


if __name__ == "__main__":
    sys.exit(main())
