#!/usr/bin/env python3
"""
Pet Monitor Live - Raspberry Pi client (v2 of the Smart Pet Monitor sensor loop).

v1 read the sensors once a second and overwrote single Firebase nodes with pyrebase:
    temperatureData/temp_C, weight/weight, ph/pH, presence/faces_detected
v2 keeps the same hardware and read approach but sends *time-stamped raw readings* to the
Pet Monitor Live server, which does calibration, history, visit detection and alerts:

    POST {server}/api/readings      header X-Device-Key: <key>
    {"deviceId", "ts", "temperatureC", "weightRaw", "phVoltage", "faces"}

Hardware (custom HAT on a Raspberry Pi 4):
    DHT22 / AM2302 temperature          GPIO4                (adafruit_dht)
    Interlink FSR under the bowl        ADS1115 channel A1   (raw 16-bit value)
    PH-4502C water pH probe             ADS1115 channel A0   (voltage)
    SEN-21231 Person Sensor             I2C address 0x62     (raw read via fcntl/struct)

Reliability:
    * Sampling and uploading run in separate threads, so a slow or dead network never
      delays sampling.
    * Readings are queued locally (bounded deque) while the server is unreachable and sent
      in batches with exponential backoff + jitter once it is back.
    * Readings older than a few seconds when sent are flagged "replay": the server stores
      them for history but does not run alerts on stale data.
    * The queue is written to a spool file on exit (and periodically) and reloaded on start.

Usage:
    python3 pi_client.py --server http://192.168.1.50:5602 --device-id pi-kitchen --key <key>
    python3 pi_client.py --mock --duration 10        # fake sensors, test the HTTP path anywhere
"""

import argparse
import collections
import json
import logging
import math
import os
import random
import signal
import struct
import threading
import time
import urllib.error
import urllib.request

log = logging.getLogger("pi_client")

REPLAY_AFTER_S = 5.0  # readings older than this when sent are marked as replayed
BATCH_SIZE = 200  # server accepts up to 500 per request
MAX_QUEUE = 6 * 3600  # ~6 h of 1 Hz readings kept while offline


# --------------------------------------------------------------------------------------
# Sensors
# --------------------------------------------------------------------------------------

class PersonSensor:
    """SEN-21231 Person Sensor read over raw I2C, the same way as the v1 firmware
    (and Useful Sensors' reference code): open /dev/i2c-1, select address 0x62 with
    ioctl(I2C_SLAVE), read the fixed-size result struct and unpack it with struct."""

    I2C_CHANNEL = 1
    I2C_PERIPHERAL = 0x703  # I2C_SLAVE ioctl request
    ADDRESS = 0x62
    HEADER_FORMAT = "BBH"  # reserved, reserved, payload size
    HEADER_BYTE_COUNT = struct.calcsize(HEADER_FORMAT)
    FACE_FORMAT = "BBBBBBbB"  # confidence, box x1 y1 x2 y2, confidence, id, is_facing
    FACE_MAX = 4
    RESULT_FORMAT = HEADER_FORMAT + "B" + FACE_FORMAT * FACE_MAX + "H"
    RESULT_BYTE_COUNT = struct.calcsize(RESULT_FORMAT)

    def __init__(self):
        import fcntl  # Linux only - imported here so --mock works on any OS
        import io

        self.handle = io.open("/dev/i2c-" + str(self.I2C_CHANNEL), "rb", buffering=0)
        fcntl.ioctl(self.handle, self.I2C_PERIPHERAL, self.ADDRESS)

    def read_faces(self):
        """Number of faces currently detected (0-4), or None if the read failed."""
        try:
            read_bytes = self.handle.read(self.RESULT_BYTE_COUNT)
        except OSError as err:
            log.debug("person sensor read failed: %s", err)
            return None
        if len(read_bytes) < self.RESULT_BYTE_COUNT:
            return None
        offset = self.HEADER_BYTE_COUNT
        (num_faces,) = struct.unpack_from("B", read_bytes, offset)
        return min(int(num_faces), self.FACE_MAX)


class RealSensors:
    """The v1 HAT: DHT22 on GPIO4, ADS1115 (A0 = pH voltage, A1 = FSR raw), Person Sensor."""

    def __init__(self):
        import adafruit_dht
        import board
        import busio
        import adafruit_ads1x15.ads1115 as ADS
        from adafruit_ads1x15.analog_in import AnalogIn

        self.dht = adafruit_dht.DHT22(board.D4)
        i2c = busio.I2C(board.SCL, board.SDA)
        ads = ADS.ADS1115(i2c)
        # adafruit-circuitpython-ads1x15 2.x exposes ADS.P0/P1; newer releases use a Pin enum.
        p0, p1 = getattr(ADS, "P0", None), getattr(ADS, "P1", None)
        if p0 is None:
            from adafruit_ads1x15.ads1x15 import Pin
            p0, p1 = Pin.A0, Pin.A1
        self.ph_channel = AnalogIn(ads, p0)
        self.fsr_channel = AnalogIn(ads, p1)
        self.person = PersonSensor()

    def read(self):
        return {
            "temperatureC": self._temperature(),
            "weightRaw": self._safe(lambda: int(self.fsr_channel.value)),
            "phVoltage": self._safe(lambda: round(float(self.ph_channel.voltage), 4)),
            "faces": self.person.read_faces(),
        }

    def _temperature(self):
        # DHT22 reads fail regularly (timing-sensitive protocol): report null, never crash.
        try:
            t = self.dht.temperature
            return None if t is None else round(float(t), 1)
        except RuntimeError as err:
            log.debug("DHT22 read failed: %s", err)
            return None

    @staticmethod
    def _safe(fn):
        try:
            return fn()
        except (OSError, ValueError) as err:
            log.debug("ADS1115 read failed: %s", err)
            return None


class MockSensors:
    """Plausible fake values so the HTTP path can be exercised on any machine."""

    def __init__(self, seed=None):
        self.rng = random.Random(seed)
        self.t0 = time.time()
        self.visit_until = 0.0

    def read(self):
        now = time.time()
        if now > self.visit_until and self.rng.random() < 0.02:
            self.visit_until = now + self.rng.uniform(5, 20)
        visiting = now < self.visit_until
        return {
            "temperatureC": round(22 + 1.5 * math.sin((now - self.t0) / 600) + self.rng.gauss(0, 0.1), 1),
            "weightRaw": int(8000 + (2500 if visiting else 0) + self.rng.gauss(0, 12)),
            "phVoltage": round(2.52 + self.rng.gauss(0, 0.002), 4),
            "faces": 1 if visiting else 0,
        }


# --------------------------------------------------------------------------------------
# Upload with local buffering
# --------------------------------------------------------------------------------------

class Uploader(threading.Thread):
    """Drains the reading queue to the server in batches; backs off while it is unreachable."""

    def __init__(self, server, key, spool_path, timeout=5.0):
        super().__init__(daemon=True)
        self.url = server.rstrip("/") + "/api/readings"
        self.key = key
        self.spool_path = spool_path
        self.timeout = timeout
        self.queue = collections.deque(maxlen=MAX_QUEUE)  # oldest dropped if offline for too long
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.failures = 0
        self.sent = 0
        self._load_spool()

    def put(self, reading):
        with self.lock:
            self.queue.append(reading)
        self.wake.set()

    def pending(self):
        with self.lock:
            return len(self.queue)

    def run(self):
        last_spool = time.monotonic()
        while not self.stopping.is_set():
            self.wake.wait(timeout=1.0)
            self.wake.clear()
            while self.pending() and not self.stopping.is_set():
                if not self._send_batch():
                    delay = self._backoff()
                    log.warning("server unreachable, %d readings buffered, retry in %.1fs", self.pending(), delay)
                    self.stopping.wait(delay)
                    break
            if self.pending() and time.monotonic() - last_spool > 30:
                self.save_spool()  # crash safety while offline
                last_spool = time.monotonic()

    def _backoff(self):
        # 1, 2, 4 ... 60 s with +-25 % jitter
        base = min(60.0, 2 ** min(self.failures - 1, 6))
        return base * random.uniform(0.75, 1.25)

    def _send_batch(self):
        with self.lock:
            batch = [self.queue[i] for i in range(min(BATCH_SIZE, len(self.queue)))]
        now_ms = int(time.time() * 1000)
        payload = [dict(r, replay=True) if now_ms - r["ts"] > REPLAY_AFTER_S * 1000 else r for r in batch]
        req = urllib.request.Request(
            self.url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Device-Key": self.key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                res.read()
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", "replace")[:300]
            if err.code == 400:
                # Permanent: the server rejected the data. Drop it rather than retry forever.
                log.error("server rejected %d readings (400): %s", len(batch), body)
                self._drop(len(batch))
                return True
            log.error("HTTP %d from server: %s", err.code, body)  # 401/5xx: keep and retry
            self.failures += 1
            return False
        except (urllib.error.URLError, OSError, TimeoutError) as err:
            log.debug("upload failed: %s", err)
            self.failures += 1
            return False
        self._drop(len(batch))
        self.sent += len(batch)
        if self.failures:
            log.info("connection restored")
        self.failures = 0
        return True

    def _drop(self, n):
        with self.lock:
            for _ in range(min(n, len(self.queue))):
                self.queue.popleft()

    def _load_spool(self):
        if not self.spool_path or not os.path.exists(self.spool_path):
            return
        try:
            with open(self.spool_path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        self.queue.append(json.loads(line))
            os.remove(self.spool_path)
            log.info("loaded %d buffered readings from %s", len(self.queue), self.spool_path)
        except (OSError, ValueError) as err:
            log.warning("could not read spool %s: %s", self.spool_path, err)

    def save_spool(self):
        if not self.spool_path:
            return
        with self.lock:
            items = list(self.queue)
        tmp = self.spool_path + ".tmp"
        try:
            if not items:
                if os.path.exists(self.spool_path):
                    os.remove(self.spool_path)
                return
            with open(tmp, "w", encoding="utf-8") as f:
                for r in items:
                    f.write(json.dumps(r) + "\n")
            os.replace(tmp, self.spool_path)  # atomic: never a half-written spool
        except OSError as err:
            log.warning("could not write spool: %s", err)

    def stop(self, flush_timeout=5.0):
        deadline = time.monotonic() + flush_timeout
        while self.pending() and time.monotonic() < deadline and self.failures == 0:
            self.wake.set()
            time.sleep(0.1)
        self.stopping.set()
        self.wake.set()
        self.join(timeout=self.timeout + 1)
        self.save_spool()


# --------------------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Pet Monitor Live Raspberry Pi client")
    p.add_argument("--server", default=os.environ.get("PETMON_SERVER", "http://127.0.0.1:5602"))
    p.add_argument("--device-id", default=os.environ.get("PETMON_DEVICE_ID", "pi-kitchen"))
    p.add_argument("--key", default=os.environ.get("PETMON_DEVICE_KEY", "dev-device-key"))
    p.add_argument("--interval", type=float, default=1.0, help="seconds between readings (v1: 1 s)")
    p.add_argument("--spool", default=os.environ.get("PETMON_SPOOL", "pet-monitor-spool.jsonl"),
                   help="file for readings not yet sent ('' to disable)")
    p.add_argument("--mock", action="store_true", help="fake sensors (no Pi hardware needed)")
    p.add_argument("--seed", type=int, help="seed for --mock")
    p.add_argument("--duration", type=float, help="stop after N seconds (testing)")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args()


def main():
    args = parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    sensors = MockSensors(args.seed) if args.mock else RealSensors()
    uploader = Uploader(args.server, args.key, args.spool or None)
    uploader.start()

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda *_: stop.set())

    log.info("sampling every %.1fs as %s -> %s%s", args.interval, args.device_id, uploader.url,
             " (mock sensors)" if args.mock else "")
    started = time.monotonic()
    next_tick = started
    taken = 0
    while not stop.is_set():
        reading = {"deviceId": args.device_id, "ts": int(time.time() * 1000), **sensors.read()}
        if any(reading[k] is not None for k in ("temperatureC", "weightRaw", "phVoltage", "faces")):
            uploader.put(reading)
            taken += 1
        if args.duration and time.monotonic() - started >= args.duration:
            break
        next_tick += args.interval  # fixed-rate schedule, no drift from read time
        stop.wait(max(0.0, next_tick - time.monotonic()))

    log.info("stopping: %d readings taken, %d sent, %d still buffered", taken, uploader.sent, uploader.pending())
    uploader.stop()
    log.info("done (%d sent, %d spooled)", uploader.sent, uploader.pending())


if __name__ == "__main__":
    main()
