#!/usr/bin/env python3
"""End-to-end tests for tinyhttpd (Python standard library only).

Starts the real server binary on a free port with a throw-away document root
and checks behaviour over real sockets: status codes, headers, keep-alive,
pipelining, security rules, back-pressure, concurrency and graceful shutdown.

    python -E -P tests/integration.py [--server build/server.exe]
"""
import argparse
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IS_WIN = os.name == "nt"
DEFAULT_SERVER = os.path.join(ROOT, "build", "server.exe" if IS_WIN else "server")

INDEX = b"<!doctype html><title>t</title><h1>hello from tinyhttpd</h1>\n"
STYLE = b"body { color: #e8ebf5; }\n"
SUB_INDEX = b"<p>sub index</p>\n"
SECRET = b"TOP-SECRET-OUTSIDE-DOCROOT\n"
BIG = bytes((i * 7 + 13) % 251 for i in range(300_000))  # > several 64 KiB chunks


class Server:
    """A running server process whose output is collected in the background."""

    def __init__(self, binary, docroot, *extra):
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if IS_WIN else 0
        self.proc = subprocess.Popen(
            [binary, "-p", "0", "-d", docroot, *extra],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            creationflags=flags)
        self.lines = []
        first = self.proc.stdout.readline().decode("utf-8", "replace")
        self.lines.append(first.rstrip())
        m = re.search(r"http://[\d.]+:(\d+)/", first)
        if not m:
            self.kill()
            raise RuntimeError("server did not start: %r" % first)
        self.port = int(m.group(1))
        self.reader = threading.Thread(target=self._drain, daemon=True)
        self.reader.start()

    def _drain(self):
        for raw in self.proc.stdout:
            self.lines.append(raw.decode("utf-8", "replace").rstrip())

    def stop(self, timeout=10.0):
        """Ask for a graceful stop (Ctrl-Break / SIGINT); returns exit code or None."""
        try:
            if IS_WIN:
                os.kill(self.proc.pid, signal.CTRL_BREAK_EVENT)
            else:
                self.proc.send_signal(signal.SIGINT)
            return self.proc.wait(timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            return None

    def kill(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()


# ---------------------------------------------------------------- helpers

SRV = None  # the main server under test


def conn(port=None, timeout=5):
    return http.client.HTTPConnection("127.0.0.1", port or SRV.port, timeout=timeout)


def get(path, method="GET", headers=None, body=None):
    c = conn()
    try:
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
    finally:
        c.close()


def raw(data, port=None, timeout=5, half_close=False):
    """Send raw bytes, read until the server closes; returns all bytes."""
    s = socket.create_connection(("127.0.0.1", port or SRV.port), timeout=timeout)
    try:
        s.sendall(data)
        if half_close:
            s.shutdown(socket.SHUT_WR)
        out = b""
        while True:
            try:
                chunk = s.recv(65536)
            except (ConnectionResetError, socket.timeout):
                break
            if not chunk:
                break
            out += chunk
        return out
    finally:
        s.close()


def status_of(resp):
    m = re.match(rb"HTTP/1\.1 (\d{3}) ", resp)
    return int(m.group(1)) if m else None


def split_responses(data):
    """Split a byte stream of back-to-back responses (all with Content-Length)."""
    out = []
    while data:
        head, sep, rest = data.partition(b"\r\n\r\n")
        if not sep:
            break
        m = re.search(rb"(?i)content-length: (\d+)", head)
        n = int(m.group(1)) if m else 0
        out.append((status_of(head), head, rest[:n]))
        data = rest[n:]
    return out


# ------------------------------------------------------------------ tests

def test_get_index():
    st, h, body = get("/")
    assert st == 200, st
    assert body == INDEX
    assert int(h["content-length"]) == len(INDEX)
    assert h["content-type"] == "text/html; charset=utf-8", h["content-type"]
    assert h["server"].startswith("tinyhttpd/")
    assert h["date"].endswith(" GMT") and "last-modified" in h


def test_mime_types():
    st, h, body = get("/style.css")
    assert st == 200 and body == STYLE
    assert h["content-type"] == "text/css; charset=utf-8"
    st, h, _ = get("/sub/page.txt")
    assert st == 200 and h["content-type"].startswith("text/plain")


def test_large_file_streamed():
    st, h, body = get("/big.bin")
    assert st == 200 and h["content-type"] == "application/octet-stream"
    assert int(h["content-length"]) == len(BIG) and body == BIG


def test_head_has_no_body():
    resp = raw(b"HEAD /index.html HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
    head, _, rest = resp.partition(b"\r\n\r\n")
    assert status_of(head) == 200
    assert b"Content-Length: %d" % len(INDEX) in head
    assert rest == b"", rest


def test_404():
    st, _, body = get("/nope.html")
    assert st == 404 and body.startswith(b"404")


def test_directory_redirect_and_index():
    st, h, _ = get("/sub?x=1")
    assert st == 301 and h["location"] == "/sub/?x=1", (st, h.get("location"))
    st, _, body = get("/sub/")
    assert st == 200 and body == SUB_INDEX


def test_traversal_forbidden():
    attempts = [
        "/../secret.txt", "/%2e%2e/secret.txt", "/%2E%2E%2Fsecret.txt",
        "/..%5csecret.txt", "/sub/../../secret.txt", "/sub/%2e%2e/%2e%2e/secret.txt",
        "/.hidden", "/con", "/sub/NUL.txt", "/index.html.", "/index.html::$DATA",
    ]
    for path in attempts:
        resp = raw(b"GET " + path.encode() + b" HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
        assert status_of(resp) == 403, (path, resp[:60])
        assert SECRET not in resp
    # encoded NUL byte and broken escapes are malformed, not forbidden
    for path in ("/index.html%00.png", "/%zz", "/%4"):
        resp = raw(b"GET " + path.encode() + b" HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
        assert status_of(resp) == 400, (path, resp[:60])


def test_405_with_allow():
    st, h, _ = get("/", method="POST", body=b"x=1")
    assert st == 405, st
    assert h["allow"] == "GET, HEAD"
    assert h["connection"] == "close"
    st, h, _ = get("/", method="DELETE")
    assert st == 405 and h["allow"] == "GET, HEAD"


def test_400_on_garbage():
    assert status_of(raw(b"garbage\r\n\r\n")) == 400
    assert status_of(raw(b"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03\r\n\r\n")) == 400  # TLS hello
    assert status_of(raw(b"GET / HTTP/1.1\r\n\r\n")) == 400  # missing Host
    assert status_of(raw(b"GET / HTTP/1.1\r\nHost: t\r\nBad Header: x\r\n\r\n")) == 400
    assert status_of(raw(b"GET / HTTP/1.1\r\nHost: t\r\n folded\r\n\r\n")) == 400
    assert status_of(raw(b"GET / HTTP/2.0\r\nHost: t\r\n\r\n")) == 505


def test_431_huge_headers():
    big = b"GET / HTTP/1.1\r\nHost: t\r\nX-Big: " + b"a" * 16000 + b"\r\n\r\n"
    resp = raw(big)
    assert status_of(resp) == 431, resp[:80]
    many = b"GET / HTTP/1.1\r\nHost: t\r\n" + b"".join(b"X-%d: v\r\n" % i for i in range(70)) + b"\r\n"
    assert status_of(raw(many)) == 431


def test_414_long_uri():
    resp = raw(b"GET /" + b"a" * 3000 + b" HTTP/1.1\r\nHost: t\r\n\r\n")
    assert status_of(resp) == 414, resp[:80]
    resp = raw(b"GET /" + b"a" * 9000 + b" HTTP/1.1\r\nHost: t\r\n\r\n")
    assert status_of(resp) == 414, resp[:80]


def test_304_if_modified_since():
    st, h, _ = get("/index.html")
    lm = h["last-modified"]
    st, h2, body = get("/index.html", headers={"If-Modified-Since": lm})
    assert st == 304 and body == b"", st
    assert "content-length" not in h2
    st, _, body = get("/index.html", headers={"If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT"})
    assert st == 200 and body == INDEX
    st, _, body = get("/index.html", headers={"If-Modified-Since": "not a date"})
    assert st == 200 and body == INDEX


def test_keepalive_reuses_socket():
    c = conn()
    try:
        socks = set()
        for path in ("/", "/style.css", "/nope", "/big.bin", "/__health"):
            c.request("GET", path)
            r = c.getresponse()
            r.read()
            assert r.getheader("Connection") == "keep-alive", r.getheaders()
            socks.add(id(c.sock))
        assert len(socks) == 1, "connection was re-opened"
    finally:
        c.close()


def test_pipelining():
    reqs = (b"GET /index.html HTTP/1.1\r\nHost: t\r\n\r\n"
            b"GET /nope HTTP/1.1\r\nHost: t\r\n\r\n"
            b"GET /style.css HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
    parts = split_responses(raw(reqs))
    assert [p[0] for p in parts] == [200, 404, 200], [p[0] for p in parts]
    assert parts[0][2] == INDEX and parts[2][2] == STYLE
    assert b"Connection: close" in parts[2][1]


def test_connection_close_and_http10():
    resp = raw(b"GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
    assert status_of(resp) == 200 and b"Connection: close" in resp and resp.endswith(INDEX)
    resp = raw(b"GET / HTTP/1.0\r\n\r\n")  # 1.0: closes by default, Host optional
    assert status_of(resp) == 200 and b"Connection: close" in resp
    s = socket.create_connection(("127.0.0.1", SRV.port), timeout=5)
    try:  # 1.0 with explicit keep-alive stays open for a second request
        for _ in range(2):
            s.sendall(b"GET /style.css HTTP/1.0\r\nConnection: keep-alive\r\n\r\n")
            data = b""
            while not data.endswith(STYLE):
                chunk = s.recv(4096)
                assert chunk, "closed early"
                data += chunk
            assert b"Connection: keep-alive" in data
    finally:
        s.close()


def test_idle_keepalive_timeout():
    s = socket.create_connection(("127.0.0.1", SRV.port), timeout=10)
    try:
        s.sendall(b"GET /__health HTTP/1.1\r\nHost: t\r\n\r\n")
        data = b""
        while not data.endswith(b"ok\n"):
            data += s.recv(4096)
        t0 = time.monotonic()
        assert s.recv(4096) == b""  # server closes the idle connection (-k 2)
        waited = time.monotonic() - t0
        assert 1.5 < waited < 4.0, waited
    finally:
        s.close()


def test_health_and_stats():
    st, h, body = get("/__health")
    assert st == 200 and body.strip() == b"ok"
    st, h, body = get("/__stats")
    assert st == 200 and h["content-type"] == "application/json"
    s = json.loads(body)
    for key in ("uptime_s", "requests_total", "by_status", "active_connections",
                "queue_depth", "workers"):
        assert key in s, key
    assert s["workers"] == 4
    assert s["requests_total"] >= 30
    assert s["by_status"].get("404", 0) >= 1 and s["by_status"].get("403", 0) >= 10
    assert s["by_status"].get("200", 0) >= 10
    assert s["active_connections"] >= 1  # at least this request
    before = s["requests_total"]
    get("/nope")
    after = json.loads(get("/__stats")[2])["requests_total"]
    assert after >= before + 2, (before, after)


def test_50_parallel_clients():
    n = 50
    barrier = threading.Barrier(n)
    results = [None] * n

    def worker(i):
        try:
            barrier.wait(timeout=10)
            path = "/big.bin" if i % 5 == 0 else "/index.html"
            st, _, body = get(path)
            results[i] = st == 200 and body == (BIG if path == "/big.bin" else INDEX)
        except Exception as e:  # noqa: BLE001 - report any failure as False
            results[i] = repr(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    bad = [r for r in results if r is not True]
    assert not bad, bad[:5]


def test_access_log():
    time.sleep(0.2)
    log = "\n".join(SRV.lines)
    assert re.search(r'127\.0\.0\.1 - - \[\d\d/\w{3}/\d{4}:\d\d:\d\d:\d\d \+0000\] '
                     r'"GET /index\.html HTTP/1\.1" 200 %d ' % len(INDEX), log), log[-500:]
    assert '"POST / HTTP/1.1" 405' in log


def test_backpressure_503(binary, docroot):
    """1 worker, queue of 1: worker pinned by an idle keep-alive client, a
    second client waits in the queue, a third must get 503 immediately."""
    srv = Server(binary, docroot, "-t", "1", "-Q", "1", "-k", "5", "-q")
    a = b = None
    try:
        a = socket.create_connection(("127.0.0.1", srv.port), timeout=5)
        a.sendall(b"GET /__health HTTP/1.1\r\nHost: t\r\n\r\n")
        data = b""
        while not data.endswith(b"ok\n"):
            data += a.recv(4096)
        b = socket.create_connection(("127.0.0.1", srv.port), timeout=5)
        time.sleep(0.5)  # let the accept loop queue b
        t0 = time.monotonic()
        resp = raw(b"", port=srv.port)
        assert status_of(resp) == 503, resp[:80]
        assert b"Retry-After: 1" in resp
        assert time.monotonic() - t0 < 2.0
        # Free the worker: the queued client b must now be served normally.
        a.close()
        a = None
        b.sendall(b"GET /__health HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
        data = b""
        while True:
            chunk = b.recv(4096)
            if not chunk:
                break
            data += chunk
        assert status_of(data) == 200 and data.endswith(b"ok\n"), data[:80]
    finally:
        for s in (a, b):
            if s:
                s.close()
        srv.kill()


def test_graceful_shutdown():
    idle = socket.create_connection(("127.0.0.1", SRV.port), timeout=5)
    try:
        idle.sendall(b"GET /__health HTTP/1.1\r\nHost: t\r\n\r\n")
        data = b""
        while not data.endswith(b"ok\n"):
            data += idle.recv(4096)
        t0 = time.monotonic()
        code = SRV.stop(timeout=10)
        if code is None and IS_WIN:
            raise SkipTest("cannot deliver Ctrl-Break (no console attached)")
        assert code == 0, code
        assert time.monotonic() - t0 < 5.0
        SRV.reader.join(5)
        log = "\n".join(SRV.lines)
        assert "shutting down" in log and "all 4 workers joined" in log, log[-400:]
        assert "stats:" in log
    finally:
        idle.close()


class SkipTest(Exception):
    pass


# ------------------------------------------------------------------- main

def make_docroot():
    base = tempfile.mkdtemp(prefix="tinyhttpd-it-")
    root = os.path.join(base, "www")
    os.makedirs(os.path.join(root, "sub"))
    files = {
        "index.html": INDEX, "style.css": STYLE, "big.bin": BIG, ".hidden": b"hidden\n",
        os.path.join("sub", "index.html"): SUB_INDEX,
        os.path.join("sub", "page.txt"): b"plain text\n",
    }
    for name, data in files.items():
        with open(os.path.join(root, name), "wb") as f:
            f.write(data)
    with open(os.path.join(base, "secret.txt"), "wb") as f:
        f.write(SECRET)
    return base, root


def main():
    global SRV
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default=DEFAULT_SERVER)
    args = ap.parse_args()
    binary = os.path.abspath(args.server)
    if not os.path.exists(binary):
        sys.exit("server binary not found: %s (run make first)" % binary)

    base, docroot = make_docroot()
    SRV = Server(binary, docroot, "-t", "4", "-k", "2")
    tests = [
        test_get_index, test_mime_types, test_large_file_streamed, test_head_has_no_body,
        test_404, test_directory_redirect_and_index, test_traversal_forbidden,
        test_405_with_allow, test_400_on_garbage, test_431_huge_headers, test_414_long_uri,
        test_304_if_modified_since, test_keepalive_reuses_socket, test_pipelining,
        test_connection_close_and_http10, test_idle_keepalive_timeout, test_health_and_stats,
        test_50_parallel_clients, test_access_log,
        lambda: test_backpressure_503(binary, docroot),
        test_graceful_shutdown,
    ]
    names = [t.__name__ if t.__name__ != "<lambda>" else "test_backpressure_503" for t in tests]
    passed = failed = skipped = 0
    try:
        for name, t in zip(names, tests):
            try:
                t()
            except SkipTest as e:
                skipped += 1
                print("SKIP %-36s %s" % (name, e))
                continue
            except Exception as e:  # noqa: BLE001 - report and keep going
                failed += 1
                print("FAIL %-36s %r" % (name, e))
                continue
            passed += 1
            print("ok   %s" % name)
    finally:
        SRV.kill()
        shutil.rmtree(base, ignore_errors=True)
    print("\n%d passed, %d failed, %d skipped" % (passed, failed, skipped))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
