#!/usr/bin/env python3
"""CPU benchmark for the runner this job landed on.

Usage:
  bench.py system   --out result.json
  bench.py passmark --out result.json --binary /tmp/passmark/pt_linux [--raw DIR]

Each subcommand merges its fields into the result file, so a failed PassMark
run still leaves the machine's CPU model behind. Job queue time is not
measured here: the publish job reads it from the GitHub API once every
benchmark job has finished (see store.py).
"""
import argparse
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time

# CPU suite only (-r 1), two iterations (-i 2), one process per vCPU (-p),
# medium test duration (-d 2).
PASSMARK_ARGS = ["-r", "1", "-i", "2", "-d", "2"]
PASSMARK_TIMEOUT = 20 * 60


def nproc():
    return os.cpu_count() or 1


# ── system ───────────────────────────────────────────────────────────────


def lscpu():
    try:
        text = subprocess.run(
            ["lscpu"], capture_output=True, text=True, check=True, env=dict(os.environ, LC_ALL="C")
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return {}
    info = {}
    for line in text.splitlines():
        key, sep, value = line.partition(":")
        # Hybrid ARM parts list one "Model name" per cluster: keep the first.
        if sep and key.strip() not in info:
            info[key.strip()] = value.strip()
    return info


def cpuinfo_model():
    try:
        text = pathlib.Path("/proc/cpuinfo").read_text()
    except OSError:
        return None
    m = re.search(r"^model name\s*:\s*(.+)$", text, re.M)
    return m.group(1).strip() if m else None


def memory_mib():
    try:
        text = pathlib.Path("/proc/meminfo").read_text()
    except OSError:
        return None
    m = re.search(r"^MemTotal:\s+(\d+) kB", text, re.M)
    return int(m.group(1)) // 1024 if m else None


def os_name():
    try:
        text = pathlib.Path("/etc/os-release").read_text()
    except OSError:
        return None
    m = re.search(r'^PRETTY_NAME="?([^"\n]+)"?', text, re.M)
    return m.group(1) if m else None


def group_system():
    cpu = lscpu()
    model = cpu.get("Model name")
    if not model or model == "-":
        model = cpuinfo_model()
    return {
        "label": os.environ.get("BENCH_LABEL"),
        "runner_name": os.environ.get("RUNNER_NAME"),
        "image_version": os.environ.get("ImageVersion"),
        "arch": platform.machine(),
        "cpu_model": model,
        "cpu_vendor": cpu.get("Vendor ID"),
        "cpus": nproc(),
        "threads_per_core": int(cpu["Thread(s) per core"]) if cpu.get("Thread(s) per core", "").isdigit() else None,
        "hypervisor": cpu.get("Hypervisor vendor"),
        "memory_mib": memory_mib(),
        "os": os_name(),
        "kernel": platform.release(),
    }


# ── passmark ─────────────────────────────────────────────────────────────


def parse_results(text):
    """Split PassMark's results_cpu.yml into {section: {key: value}}.

    Only the top two levels matter (Version, Results, SystemInformation), so
    this avoids a YAML dependency on the runner.
    """
    sections, current = {}, None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, sep, value = stripped.partition(":")
        if not sep:
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            current = sections.setdefault(key.strip(), {})
        elif indent == 2 and current is not None:
            # Quoted values can carry padding inside the quotes (Processor).
            current[key.strip()] = value.strip().strip('"').strip()
    return sections


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def summarize(sections):
    version = sections.get("Version", {})
    results = sections.get("Results", {})
    system = sections.get("SystemInformation", {})
    tests = {}
    for key, value in results.items():
        if key.startswith(("CPU_", "m_CPU_")) or key == "SUMM_CPU":
            v = number(value)
            if v is not None:
                tests[key] = round(v, 1) if abs(v) < 1e6 else round(v)
    ver = ".".join(version[k] for k in ("Major", "Minor", "Build") if version.get(k))
    return {
        "passmark_version": ver or None,
        "passmark_complete": results.get("Results Complete") == "true",
        "passmark_processes": int(number(results.get("NumTestProcesses")) or 0) or None,
        "passmark_processor": system.get("Processor") or None,
        "cpu_mark": tests.get("SUMM_CPU"),
        "single_thread": tests.get("CPU_SINGLETHREAD"),
        "passmark": tests,
    }


def group_passmark(binary, raw_dir):
    binary = pathlib.Path(binary).resolve()
    if not binary.exists():
        raise RuntimeError(f"PassMark binary not found at {binary}")
    workdir = pathlib.Path(tempfile.mkdtemp(prefix="passmark-"))
    log = workdir / "passmark.log"
    cmd = " ".join([str(binary), *PASSMARK_ARGS, "-p", str(nproc())])
    print(f"+ {cmd}", flush=True)
    started = time.monotonic()
    # pt_linux is an ncurses program and needs a terminal: script(1) gives it
    # a pty. Its screen output is escape-code noise, so it goes to a file.
    with log.open("w") as out:
        res = subprocess.run(
            ["script", "-q", "-c", cmd, "/dev/null"],
            cwd=workdir, stdout=out, stderr=subprocess.STDOUT,
            env=dict(os.environ, TERM="xterm"), timeout=PASSMARK_TIMEOUT,
        )
    elapsed = round(time.monotonic() - started, 1)
    results = workdir / "results_cpu.yml"
    if raw_dir:
        raw_dir = pathlib.Path(raw_dir)
        raw_dir.mkdir(parents=True, exist_ok=True)
        for f in (results, log):
            if f.exists():
                shutil.copy(f, raw_dir / f.name)
    if not results.exists():
        raise RuntimeError(f"PassMark exited {res.returncode} without writing results_cpu.yml")
    text = results.read_text(errors="replace")
    print(text, flush=True)
    summary = summarize(parse_results(text))
    summary["passmark_seconds"] = elapsed
    if not summary["passmark_complete"] or summary["cpu_mark"] is None:
        raise RuntimeError("PassMark results are incomplete (no SUMM_CPU)")
    return summary


# ── main ─────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("group", choices=["system", "passmark"])
    parser.add_argument("--out", required=True)
    parser.add_argument("--binary", default="/tmp/passmark/pt_linux")
    parser.add_argument("--raw", help="directory to copy results_cpu.yml and the PassMark log into")
    args = parser.parse_args()

    path = pathlib.Path(args.out)
    result = json.loads(path.read_text()) if path.exists() else {}
    status = 0
    try:
        if args.group == "system":
            result.update(group_system())
        else:
            result.pop("error", None)
            result.update(group_passmark(args.binary, args.raw))
    except Exception as exc:  # keep whatever was already collected
        print(f"::error::{args.group} failed: {exc}", flush=True)
        result["error"] = f"{args.group}: {exc}"[:500]
        status = 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k != "passmark"}, indent=2))
    return status


if __name__ == "__main__":
    sys.exit(main())
