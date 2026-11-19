#!/usr/bin/env python3
"""
verify_server.py — Self-test of the FigureUS(out) local server on synthetic data (no real data).

Starts server/app.py on a spare port with a temporary jobs folder, then checks that it:
  - answers only requests addressed to this computer, and refuses changes without its header;
  - takes an upload (keeping folder paths) and a CSV used in place;
  - runs evaluate.py: NEEDS INPUT is passed back, --validate-only gives the cohort, the confirmed
    cohort id runs the evaluation, and the reported values are evaluate.py's own;
  - serves the saved files and a zip, and refuses paths outside a run.

Usage : python scripts/verify_server.py      (exit code 0 = every check passed)
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server" / "app.py"
MAKE_DATA = ROOT / "scripts" / "make_synthetic_data.py"
HEADER = {"x-figureus": "1"}
RESULTS: list[tuple[str, bool]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not ok else ""))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Client:
    def __init__(self, port: int):
        self.base = f"http://127.0.0.1:{port}"

    def request(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def json(self, method: str, path: str, payload=None, header: bool = True, host: str | None = None):
        headers = {"content-type": "application/json", **(HEADER if header else {})}
        if host:
            headers["Host"] = host
        code, raw = self.request(method, path, json.dumps(payload).encode() if payload is not None else None, headers)
        return code, json.loads(raw or b"null")

    def upload(self, files: dict[str, bytes]):
        boundary = uuid.uuid4().hex
        parts = []
        for name, data in files.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{name}"\r\n'
                         f"Content-Type: application/octet-stream\r\n\r\n".encode() + data + b"\r\n")
        body = b"".join(parts) + f"--{boundary}--\r\n".encode()
        code, raw = self.request("POST", "/api/jobs/upload", body,
                                 {**HEADER, "content-type": f"multipart/form-data; boundary={boundary}"})
        return code, json.loads(raw)

    def run(self, job: str, kind: str, options: dict, cohort_id: str | None = None, group: str | None = None) -> dict:
        _, started = self.json("POST", f"/api/jobs/{job}/runs",
                               {"kind": kind, "options": options, "cohort_id": cohort_id, "group": group})
        for _ in range(600):
            _, view = self.json("GET", f"/api/runs/{started['run_id']}")
            if view["state"] == "finished":
                return view
            time.sleep(0.25)
        raise TimeoutError("the run did not finish")


def main() -> None:
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        data = tmp / "synthetic_data"
        subprocess.run([sys.executable, str(MAKE_DATA), "--out", str(data)], check=True, capture_output=True)
        port = free_port()
        server = subprocess.Popen([sys.executable, str(SERVER), "--port", str(port), "--no-browser",
                                   "--jobs-dir", str(tmp / "jobs")], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        try:
            c = Client(port)
            for _ in range(100):
                try:
                    if c.json("GET", "/api/health")[0] == 200:
                        break
                except OSError:
                    time.sleep(0.1)
            code, _ = c.json("GET", "/api/health")
            check("server answers on 127.0.0.1", code == 200)

            code, _ = c.json("GET", "/api/health", host="example.com")
            check("requests addressed to another host are refused (403)", code == 403)
            code, _ = c.json("POST", "/api/jobs/path", {"path": "/nowhere.csv"}, header=False)
            check("changes without the FigureUS(out) header are refused (403)", code == 403)

            # Upload a folder-shaped CSV with renamed columns.
            known = (data / "regression" / "tiny_known.csv").read_text()
            renamed = known.replace("record_id,true,pred", "ID,TRUE,PRED", 1)
            code, job = c.upload({"study/sub/renamed.csv": renamed.encode(), "study/readme.txt": b"x"})
            check("upload keeps folder paths and finds the CSV",
                  code == 200 and job["csv_files"] == ["study/sub/renamed.csv"] and job["n_files"] == 2, str(job))
            code, _ = c.upload({"../escape.csv": b"a,b\n"})
            check("upload refuses a path that leaves the job folder (400)", code == 400)
            code, summary = c.json("GET", f"/api/jobs/{job['job_id']}/csv?name=study/sub/renamed.csv")
            check("CSV summary gives column names and row count only",
                  code == 200 and summary["columns"] == ["ID", "TRUE", "PRED"] and summary["rows"] == 4, str(summary))

            options = {"task": "regression", "csv": "study/sub/renamed.csv", "test_set": "internal",
                       "columns": {"record_id": "ID", "true": "TRUE", "pred": "PRED"}, "participant_col": None,
                       "id_format": "plain", "unit": "days"}
            view = c.run(job["job_id"], "check", {**options, "unit": None})
            check("a missing choice comes back as NEEDS INPUT with its field",
                  view["status"] == "needs_input" and view.get("field") == "unit", str(view)[:300])
            view = c.run(job["job_id"], "check", options)
            cohort = view.get("cohort") or {}
            check("check runs --validate-only and returns the cohort",
                  view["status"] == "ok" and cohort.get("total_participants") == 4 and "results" not in view, str(view)[:300])
            bad = c.run(job["job_id"], "evaluate", options, "0" * 16)
            check("a cohort id that does not match is sent back to Retry", bad["status"] == "retry")
            view = c.run(job["job_id"], "evaluate", options, cohort.get("cohort_id"), group="test-pair")
            res = view.get("results") or {}
            mae = next((m for m in res.get("metrics", []) if m["metric"] == "MAE"), {})
            check("the confirmed cohort runs the evaluation; values are evaluate.py's reported text",
                  view["status"] == "ok" and mae.get("estimate_reported") == "2.50", str(mae))
            check("figures come with their titles",
                  any(f["title"] == "Internal Test: Bland-Altman Plot" for f in res.get("figures", [])))
            check("column mapping is in the run record",
                  res.get("meta", {}).get("column_mapping") == {"record_id": "ID", "true": "TRUE", "pred": "PRED"})

            rid = view["run_id"]
            code, _ = c.request("GET", f"/api/runs/{rid}/files/{res['report_file']}")
            check("saved files are served", code == 200)
            figs = res.get("figures", [])
            check("every figure lists its TIFF, JPEG and SVG copies (--export-figures)",
                  bool(figs) and all(set(f.get("exports", {})) == {"tiff", "jpeg", "svg"} for f in figs), str(figs)[:300])
            ex = figs[0]["exports"] if figs else {}
            got = {k: c.request("GET", f"/api/runs/{rid}/files/{v}?download=true") for k, v in ex.items()}
            check("the TIFF, JPEG and SVG are served",
                  bool(got) and all(code == 200 for code, _ in got.values())
                  and got["tiff"][1][:4] in (b"II*\x00", b"MM\x00*") and got["jpeg"][1][:2] == b"\xff\xd8"
                  and b"<svg" in got["svg"][1][:2000])
            code, raw = c.request("GET", f"/api/runs/{rid}/download")
            check("all results download as one zip", code == 200 and raw[:2] == b"PK")
            code, _ = c.request("GET", f"/api/runs/{rid}/files/..%2F..%2Fjob.json")
            check("paths outside the run are refused (404)", code == 404)
            code, runs = c.json("GET", "/api/runs")
            check("recent runs list the finished evaluation with its group (internal + external together)",
                  code == 200 and any(r["run_id"] == rid and r["group"] == "test-pair" for r in runs))

            code, pjob = c.json("POST", "/api/jobs/path", {"path": str(data / "regression" / "tiny_known.csv")})
            check("a CSV can be used in place by its path", code == 200 and pjob["source"] == "path")
        finally:
            server.terminate()
            server.wait(timeout=10)
    failed = [r for r in RESULTS if not r[1]]
    print("=" * 60)
    print(f"{len(RESULTS) - len(failed)} of {len(RESULTS)} server checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
