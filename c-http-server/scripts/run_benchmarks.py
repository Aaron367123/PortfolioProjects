#!/usr/bin/env python3
"""Run the tinyhttpd benchmark matrix and save the results as JSON.

For every combination of
    worker threads  1, 2, 4, 8
    file            small.html (1 KiB), large.html (100 KiB)
    keep-alive      off, on
it starts `server -q -t <workers>`, runs one warm-up and then REPS measured
`bench -c 32 -n 20000 [-k]` runs, and keeps the median run (by requests/sec).

    python -E -P scripts/run_benchmarks.py [--reps 3] [--requests 20000]

Output: benchmarks/results.json (+ a Markdown table on stdout).
"""
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IS_WIN = os.name == "nt"
EXE = ".exe" if IS_WIN else ""
SERVER = os.path.join(ROOT, "build", "server" + EXE)
BENCH = os.path.join(ROOT, "build", "bench" + EXE)
DOCROOT = os.path.join(ROOT, "build", "bench-www")
OUT = os.path.join(ROOT, "benchmarks", "results.json")

WORKERS = [1, 2, 4, 8]
FILES = [("small.html", 1024), ("large.html", 100 * 1024)]
CONCURRENCY = 32


def make_docroot():
    os.makedirs(DOCROOT, exist_ok=True)
    for name, size in FILES:
        head = b"<!doctype html><title>bench</title><p>"
        tail = b"</p>\n"
        filler = (b"tinyhttpd benchmark payload " * (size // 28 + 1))[: size - len(head) - len(tail)]
        with open(os.path.join(DOCROOT, name), "wb") as f:
            f.write(head + filler + tail)
        assert os.path.getsize(os.path.join(DOCROOT, name)) == size


def start_server(workers):
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if IS_WIN else 0
    p = subprocess.Popen([SERVER, "-q", "-p", "0", "-t", str(workers), "-d", DOCROOT],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=flags)
    line = p.stdout.readline().decode()
    m = re.search(r":(\d+)/", line)
    if not m:
        p.kill()
        raise RuntimeError("server failed to start: " + line)
    return p, int(m.group(1))


def stop_server(p):
    try:
        if IS_WIN:
            os.kill(p.pid, signal.CTRL_BREAK_EVENT)
        else:
            p.send_signal(signal.SIGINT)
        p.wait(timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        p.kill()
        p.wait()


def parse(text):
    def num(pattern):
        m = re.search(pattern, text)
        return float(m.group(1)) if m else None
    lat = re.search(r"min ([\d.]+)\s+avg ([\d.]+)\s+p50 ([\d.]+)\s+p90 ([\d.]+)\s+"
                    r"p99 ([\d.]+)\s+max ([\d.]+)", text)
    return {
        "completed": num(r"completed\s+(\d+)"),
        "failed": num(r"failed\s+(\d+)"),
        "non2xx": num(r"non-2xx\s+(\d+)"),
        "connections": num(r"connections\s+(\d+) opened"),
        "seconds": num(r"total time\s+([\d.]+) s"),
        "rps": num(r"requests/sec\s+([\d.]+)"),
        "mbps": num(r"MB body \(([\d.]+) MB/s\)"),
        "lat_ms": dict(zip(["min", "avg", "p50", "p90", "p99", "max"],
                           map(float, lat.groups()))) if lat else None,
    }


def run_bench(port, path, keepalive, n):
    cmd = [BENCH, "-c", str(CONCURRENCY), "-n", str(n)]
    if keepalive:
        cmd.append("-k")
    cmd.append("http://127.0.0.1:%d/%s" % (port, path))
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=600).stdout
    return out, parse(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--requests", type=int, default=20000)
    args = ap.parse_args()
    for b in (SERVER, BENCH):
        if not os.path.exists(b):
            sys.exit("missing %s - run make first" % b)
    make_docroot()

    results = []
    for workers in WORKERS:
        for fname, size in FILES:
            for ka in (False, True):
                p, port = start_server(workers)
                try:
                    run_bench(port, fname, ka, 2000)  # warm-up (page cache, TCP stack)
                    runs = []
                    for _ in range(args.reps):
                        text, r = run_bench(port, fname, ka, args.requests)
                        runs.append((r["rps"] or 0.0, text, r))
                        time.sleep(1.0)  # let TIME_WAIT sockets settle between runs
                    runs.sort(key=lambda x: x[0])
                    rps, text, r = runs[len(runs) // 2]
                finally:
                    stop_server(p)
                r.update(workers=workers, file=fname, size=size, keepalive=ka,
                         all_rps=[x[0] for x in runs], output=text)
                results.append(r)
                print("w=%d %-10s ka=%-5s %9.0f req/s  p50 %.2f ms  p99 %.2f ms  failed %d"
                      % (workers, fname, ka, rps, r["lat_ms"]["p50"], r["lat_ms"]["p99"],
                         r["failed"]), flush=True)
                time.sleep(2.0)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    meta = {"concurrency": CONCURRENCY, "requests": args.requests, "reps": args.reps,
            "date": time.strftime("%Y-%m-%d")}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "results": results}, f, indent=2)

    print("\n| file | keep-alive | workers | req/s | MB/s | p50 ms | p90 ms | p99 ms | max ms | errors |")
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in results:
        l = r["lat_ms"]
        print("| %s | %s | %d | %.0f | %.1f | %.2f | %.2f | %.2f | %.1f | %d |" % (
            r["file"], "on" if r["keepalive"] else "off", r["workers"], r["rps"], r["mbps"],
            l["p50"], l["p90"], l["p99"], l["max"], r["failed"] + r["non2xx"]))


if __name__ == "__main__":
    main()
