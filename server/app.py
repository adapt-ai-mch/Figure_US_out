#!/usr/bin/env python3
"""
FigureUS(out) local server.

Runs scripts/evaluate.py for the FigureUS(out) GUI and serves the built GUI, on this computer only
(it listens on 127.0.0.1, so no other computer can reach it). It never calculates a metric: every
number it returns is read from the files evaluate.py saved.

Usage (from the skill folder, with the virtual environment active):
    python server/app.py                   # http://127.0.0.1:8765, opens the browser
    python server/app.py --port 9000 --no-browser

Uploaded files and results go to eval_output/gui_jobs/, which git ignores.
"""
from __future__ import annotations

import argparse
import io
import json
import re
import shutil
import subprocess
import sys
import threading
import uuid
import webbrowser
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Literal

import pandas as pd
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, Field

# ============================================================
# CONFIG
# ============================================================
ROOT = Path(__file__).resolve().parent.parent
EVALUATE = ROOT / "scripts" / "evaluate.py"
PYTHON = sys.executable                                # the interpreter running this server (the skill's .venv)
GUI_DIST = ROOT / "gui" / "dist"                       # built GUI (npm --prefix gui run build)
JOBS_DIR = ROOT / "eval_output" / "gui_jobs"           # uploads and results; eval_output/ is git-ignored
HOST = "127.0.0.1"                                     # this computer only
PORT = 8765
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}             # Host header check: blocks DNS-rebinding pages
API_HEADER = "x-figureus"                              # required on API calls that change something:
                                                       # other web pages cannot send it without permission
MAX_UPLOAD_FILES = 200_000                             # folder uploads (masks, XML files, images)
MAX_ISSUES = 500                                       # validation problems sent to the GUI (all are in the sheet)
LABEL_VALUES_MAX = 10                                  # label lists offered as choices, never identifier lists
LOG_TAIL = 40                                          # log lines shown when a run stops unexpectedly

EXIT_STATUS = {0: "ok", 1: "error", 2: "needs_input", 3: "retry", 4: "missing_column", 5: "invalid"}
# NEEDS INPUT messages name the option to pass; the GUI highlights the matching field.
NEEDS_INPUT_FIELDS = [
    ("--repeated-measures", "repeated_measures"), ("--empty-both", "empty_both"),
    ("--participant-col", "participant_col"), ("--positive-label", "positive_label"),
    ("--negative-label", "negative_label"), ("--prob-confirmed", "prob_confirmed"),
    ("--dca-min", "dca"), ("--unit", "unit"), ("--test-set", "test_set"), ("--mode", "mode"),
    ("positive label '", "positive_label"), ("threshold range", "dca"),
    ("title has", "title"), ("column named", "columns"), ("mapped to two names", "columns"),
]
STEP_LINE = re.compile(r"\[Step (\d+)/(\d+)\] (.*)$")

app = FastAPI(title="FigureUS(out) local server", docs_url=None, redoc_url=None, openapi_url=None)
RUNNING: dict[str, dict] = {}          # run_id -> {"proc", "lines"} while evaluate.py is working
LOCK = threading.Lock()


# ============================================================
# SAFETY: this computer only
# ============================================================
@app.middleware("http")
async def local_only(request: Request, call_next):
    """Answer only requests addressed to this computer; changes need the FigureUS(out) header."""
    host = (request.headers.get("host") or "").strip()
    host = host[1:host.index("]")] if host.startswith("[") else host.rsplit(":", 1)[0]
    if host not in ALLOWED_HOSTS:
        return JSONResponse({"detail": "FigureUS(out) answers only on this computer."}, status_code=403)
    if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD") \
            and request.headers.get(API_HEADER) != "1":
        return JSONResponse({"detail": "Requests must come from the FigureUS(out) page."}, status_code=403)
    return await call_next(request)


def safe_rel(name: str) -> Path:
    """A relative path from an upload, with no way out of the job folder."""
    parts = [p for p in re.split(r"[\\/]+", name or "") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        raise HTTPException(400, f"Unusable file name in the upload: '{name}'.")
    return Path(*parts)


def inside(base: Path, rel: str) -> Path:
    """base/rel, refused when it would leave base."""
    target = (base / rel).resolve()
    if target != base.resolve() and base.resolve() not in target.parents:
        raise HTTPException(404, "Not found.")
    return target


# ============================================================
# JOBS: one predictions CSV (plus its files) per job
# ============================================================
def job_dir(job_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", job_id or ""):
        raise HTTPException(404, "Unknown job.")
    d = JOBS_DIR / job_id
    if not (d / "job.json").exists():
        raise HTTPException(404, "This job is no longer on this computer. Choose the CSV again.")
    return d


def load_job(job_id: str) -> dict:
    return json.loads((job_dir(job_id) / "job.json").read_text(encoding="utf-8"))


def new_job(source: str, base: Path, csv_files: list[str], n_files: int) -> dict:
    job_id = uuid.uuid4().hex[:12]
    d = JOBS_DIR / job_id
    d.mkdir(parents=True, exist_ok=True)
    job = {"job_id": job_id, "created": datetime.now().isoformat(timespec="seconds"), "source": source,
           "base": str(base), "csv_files": csv_files, "n_files": n_files}
    (d / "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
    return job


def public_job(job: dict) -> dict:
    """What the GUI needs; the folder path is shown only for files used in place."""
    out = {k: job[k] for k in ("job_id", "source", "csv_files", "n_files")}
    if job["source"] == "path":
        out["folder"] = job["base"]
    return out


def csv_path(job: dict, name: str) -> Path:
    if name not in job["csv_files"]:
        raise HTTPException(400, "That CSV is not part of this job.")
    return Path(job["base"]) / name


def read_header(path: Path) -> pd.DataFrame:
    """Every cell as text, as evaluate.py reads it."""
    try:
        df = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    except Exception as e:  # noqa: BLE001 - shown to the user as a plain message
        raise HTTPException(400, f"Could not read the CSV: {e}") from e
    df.columns = [str(c).strip() for c in df.columns]
    return df


@app.post("/api/jobs/upload")
async def upload_job(request: Request):
    """Files chosen in the browser (one CSV, or a folder with its masks / XML files / images)."""
    form = await request.form(max_files=MAX_UPLOAD_FILES, max_fields=100)
    files = [f for f in form.getlist("files") if hasattr(f, "filename")]
    if not files:
        raise HTTPException(400, "No file was received.")
    job_id = uuid.uuid4().hex[:12]
    base = JOBS_DIR / job_id / "input"
    for f in files:
        dest = base / safe_rel(f.filename)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as out:
            shutil.copyfileobj(f.file, out, length=1 << 20)
    csvs = sorted(str(p.relative_to(base)) for p in base.rglob("*")
                  if p.is_file() and p.suffix.lower() == ".csv" and not p.name.startswith("."))
    if not csvs:
        shutil.rmtree(JOBS_DIR / job_id, ignore_errors=True)
        raise HTTPException(400, "There is no .csv file in what you chose.")
    (JOBS_DIR / job_id).mkdir(parents=True, exist_ok=True)
    job = {"job_id": job_id, "created": datetime.now().isoformat(timespec="seconds"), "source": "upload",
           "base": str(base), "csv_files": csvs, "n_files": len(files)}
    (JOBS_DIR / job_id / "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
    return public_job(job)


class PathBody(BaseModel):
    path: str = Field(min_length=1, max_length=4096)


@app.post("/api/jobs/path")
def path_job(body: PathBody):
    """A CSV used where it is on this computer (nothing is copied)."""
    p = Path(body.path.strip().strip("'\"")).expanduser()
    if not p.is_absolute():
        raise HTTPException(400, "Give the full path, starting with / (in Finder: select the file, then Option-Command-C).")
    if not p.is_file():
        raise HTTPException(400, "No file at that path.")
    if p.suffix.lower() != ".csv":
        raise HTTPException(400, "That file is not a .csv file.")
    return public_job(new_job("path", p.parent, [p.name], 1))


@app.get("/api/jobs/{job_id}/csv")
def csv_summary(job_id: str, name: str):
    """Column names and row count only (no values)."""
    df = read_header(csv_path(load_job(job_id), name))
    return {"name": name, "columns": list(df.columns), "rows": len(df)}


@app.get("/api/jobs/{job_id}/labels")
def csv_labels(job_id: str, name: str, column: str):
    """The distinct values of a label column, offered as choices for the positive label.
    Returned only when the column looks like labels (few values, repeated), never for identifiers."""
    df = read_header(csv_path(load_job(job_id), name))
    if column not in df.columns:
        raise HTTPException(400, f"The CSV has no column '{column}'.")
    values = sorted({v.strip() for v in df[column]} - {""})
    if len(values) > LABEL_VALUES_MAX or len(values) >= len(df):
        return {"values": None}
    return {"values": values}


# ============================================================
# RUNS: one evaluate.py call each (a check, or the full evaluation)
# ============================================================
class Options(BaseModel):
    task: Literal["classification", "regression", "detection", "segmentation"]
    csv: str
    test_set: Literal["internal", "external"] | None = None
    title: str | None = Field(default=None, max_length=400)
    columns: dict[str, str] = {}                 # name evaluate.py expects -> CSV column
    participant_col: str | None = None
    id_format: Literal["plain", "visit"] = "plain"
    mode: Literal["standard", "fgr"] | None = None
    positive_label: str | None = None
    negative_label: str | None = None
    prob_confirmed: bool = False
    dca_min: float | None = None
    dca_max: float | None = None
    unit: str | None = None
    repeated_measures: Literal["participant-mean", "all-pairs-anova"] | None = None
    empty_both: Literal["exclude", "one"] | None = None
    frame_offset: int = 0
    exclude_invalid: bool = False


class RunBody(BaseModel):
    kind: Literal["check", "evaluate"]
    options: Options
    cohort_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{16}$")
    group: str | None = Field(default=None, pattern=r"^[0-9a-z-]{1,40}$")  # runs evaluated together (internal + external)


def build_command(job: dict, o: Options, kind: str, cohort_id: str | None, out: Path) -> list[str]:
    """The evaluate.py command line. The GUI confirms the cohort itself, so --confirm is always 'gui'."""
    cmd = [PYTHON, str(EVALUATE), "--task", o.task, "--csv", str(csv_path(job, o.csv)),
           "--out-dir", str(out), "--status-file", str(out.parent / "status.json"), "--confirm", "gui"]
    for name, col in sorted(o.columns.items()):
        if col and name != col:
            cmd += ["--column", f"{name}={col}"]
    pairs = {"--test-set": o.test_set, "--title": (o.title or "").strip() or None, "--mode": o.mode,
             "--participant-col": o.participant_col, "--positive-label": o.positive_label,
             "--negative-label": o.negative_label, "--unit": (o.unit or "").strip() or None,
             "--repeated-measures": o.repeated_measures, "--empty-both": o.empty_both}
    for flag, value in pairs.items():
        if value:
            cmd += [flag, value]
    if o.dca_min is not None:
        cmd += ["--dca-min", repr(o.dca_min)]
    if o.dca_max is not None:
        cmd += ["--dca-max", repr(o.dca_max)]
    if o.id_format == "visit":
        cmd += ["--id-format", "visit"]
    if o.prob_confirmed:
        cmd.append("--prob-confirmed")
    if o.frame_offset:
        cmd += ["--frame-offset", str(o.frame_offset)]
    if o.exclude_invalid:
        cmd.append("--exclude-invalid")
    if kind == "check":
        cmd.append("--validate-only")
    else:
        if not cohort_id:
            raise HTTPException(400, "Confirm the cohort before the evaluation runs.")
        cmd += ["--confirmed-cohort", cohort_id, "--export-figures"]  # TIFF, JPEG (600 dpi) and SVG for download
    return cmd


def _watch(run_id: str, proc: subprocess.Popen, run_dir: Path) -> None:
    """Keep evaluate.py's log for progress, then record that it finished."""
    with (run_dir / "stdout.log").open("w", encoding="utf-8") as f:
        for line in proc.stdout:
            f.write(line)
            f.flush()
            RUNNING[run_id]["lines"].append(line.rstrip("\n"))
    proc.wait()
    (run_dir / "finished.json").write_text(
        json.dumps({"returncode": proc.returncode, "finished": datetime.now().isoformat(timespec="seconds")}),
        encoding="utf-8")
    with LOCK:
        RUNNING.pop(run_id, None)


@app.post("/api/jobs/{job_id}/runs")
def start_run(job_id: str, body: RunBody):
    job = load_job(job_id)
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    run_dir = job_dir(job_id) / "runs" / run_id
    out = run_dir / "out"
    out.mkdir(parents=True)
    cmd = build_command(job, body.options, body.kind, body.cohort_id, out)
    (run_dir / "request.json").write_text(json.dumps(
        {"run_id": run_id, "job_id": job_id, "kind": body.kind, "options": body.options.model_dump(),
         "cohort_id": body.cohort_id, "group": body.group, "started": datetime.now().isoformat(timespec="seconds")},
        indent=2),
        encoding="utf-8")
    proc = subprocess.Popen(cmd, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
    with LOCK:
        RUNNING[run_id] = {"proc": proc, "lines": []}
    threading.Thread(target=_watch, args=(run_id, proc, run_dir), daemon=True).start()
    return {"run_id": run_id}


def find_run(run_id: str) -> Path:
    if not re.fullmatch(r"\d{8}-\d{6}-[0-9a-f]{6}", run_id or ""):
        raise HTTPException(404, "Unknown run.")
    hits = list(JOBS_DIR.glob(f"*/runs/{run_id}"))
    if not hits:
        raise HTTPException(404, "This run is no longer on this computer.")
    return hits[0]


def progress(lines: list[str]) -> dict | None:
    for line in reversed(lines):
        m = STEP_LINE.search(line)
        if m:
            return {"step": int(m.group(1)), "total": int(m.group(2)), "label": m.group(3)}
    return None


def read_json(path: Path) -> dict | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def sheet_records(path: Path, keep: list[str] | None = None) -> list[dict]:
    """A saved sheet as text, exactly as evaluate.py wrote it (NA stays NA)."""
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    if keep:
        df = df[[c for c in keep if c in df.columns]]
    return df.to_dict("records")


def one(out: Path, pattern: str) -> Path | None:
    hits = sorted(out.glob(pattern))
    return hits[-1] if hits else None


def run_view(run_dir: Path) -> dict:
    """Everything the GUI shows for a run, read from what evaluate.py saved."""
    req = read_json(run_dir / "request.json")
    run_id, out = run_dir.name, run_dir / "out"
    view = {"run_id": run_id, "job_id": req["job_id"], "kind": req["kind"], "options": req["options"],
            "started": req["started"], "group": req.get("group")}
    live = RUNNING.get(run_id)
    if live is not None:
        return view | {"state": "running", "progress": progress(live["lines"])}
    status, finished = read_json(run_dir / "status.json"), read_json(run_dir / "finished.json")
    if status is None and finished is None:  # the server stopped while this run was working
        return view | {"state": "finished", "exit_code": 1, "status": "error",
                       "message": "This run did not finish (the FigureUS(out) server stopped). Run it again."}
    code = status["exit_code"] if status else finished["returncode"]
    view |= {"state": "finished", "exit_code": code, "status": EXIT_STATUS.get(code, "error"),
             "message": (status or {}).get("message", "")}
    if finished:
        view["finished"] = finished["finished"]
    if status is None or code == 1:
        lines = (run_dir / "stdout.log").read_text(encoding="utf-8", errors="replace").splitlines() \
            if (run_dir / "stdout.log").exists() else []
        view["log_tail"] = lines[-LOG_TAIL:]
        if status is None:
            view["message"] = "evaluate.py stopped with an unexpected error. The end of its log is below."
    if code == 2:
        view["field"] = next((f for key, f in NEEDS_INPUT_FIELDS if key in view["message"]), None)
    tag = (status or {}).get("file_tag", "*")
    if (p := one(out, f"sheets/validation_issues_{tag}.csv")) is not None:
        rows = sheet_records(p)
        view["issues"] = {"total": len(rows), "rows_affected": len({r["csv_line"] for r in rows}),
                          "rows": rows[:MAX_ISSUES], "sheet": f"sheets/{p.name}"}
    if (p := one(out, f"logs/cohort_{tag}.json")) is not None:
        view["cohort"] = read_json(p)
    if req["kind"] == "evaluate" and code == 0:
        view["results"] = results(out, tag)
    return view


EXPORT_FORMATS = ("tiff", "jpeg", "svg")


def figure_exports(out: Path, png_name: str) -> dict[str, str]:
    """The --export-figures copies of one figure that exist (runs made before exports have none)."""
    stem = Path(png_name).stem
    return {ext: f"figures/export/{stem}.{ext}" for ext in EXPORT_FORMATS
            if (out / "figures" / "export" / f"{stem}.{ext}").is_file()}


def results(out: Path, tag: str) -> dict:
    meta = read_json(one(out, f"logs/run_metadata_{tag}.json")) or {}
    metrics = one(out, f"sheets/metrics_{tag}.csv")
    report = one(out, f"reports/summary_{tag}.md")
    keep_meta = ["run_name", "test_set", "title", "task", "mode", "units", "n_participants", "n_observations",
                 "observation_unit", "n_rows_csv", "n_rows_excluded", "random_seed", "n_boot", "ci_method",
                 "cohort_id", "column_mapping", "participant_link"]
    return {
        "meta": {k: meta.get(k) for k in keep_meta},
        "metrics": sheet_records(metrics, ["group", "metric", "estimate_reported", "ci_95_reported", "unit",
                                           "n_boot_contributed", "n_boot_requested", "note"]) if metrics else [],
        "figures": [{"file": f"figures/{name}", "title": title, "exports": figure_exports(out, name)}
                    for name, title in meta.get("figure_titles", {}).items() if (out / "figures" / name).exists()],
        "notices": meta.get("notices", []),
        "report": report.read_text(encoding="utf-8") if report else "",
        "report_file": f"reports/{report.name}" if report else None,
        "metrics_file": f"sheets/{metrics.name}" if metrics else None,
        "files": [{"file": str(p.relative_to(out)), "bytes": p.stat().st_size}
                  for p in sorted(out.rglob("*")) if p.is_file()],
    }


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    return run_view(find_run(run_id))


@app.get("/api/runs/{run_id}/files/{rel:path}")
def run_file(run_id: str, rel: str, download: bool = False):
    path = inside(find_run(run_id) / "out", rel)
    if not path.is_file():
        raise HTTPException(404, "Not found.")
    return FileResponse(path, filename=path.name if download else None)


@app.get("/api/runs/{run_id}/download")
def run_zip(run_id: str):
    """Every file the run saved, as one zip."""
    run_dir = find_run(run_id)
    out = run_dir / "out"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(out.rglob("*")):
            if p.is_file():
                z.write(p, p.relative_to(out))
    status = read_json(run_dir / "status.json") or {}
    name = f"figureus_{status.get('file_tag', run_id)}.zip"
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/runs")
def recent_runs(limit: int = 50):
    """Finished evaluations on this computer, newest first."""
    rows = []
    for run_dir in JOBS_DIR.glob("*/runs/*"):
        req, status = read_json(run_dir / "request.json"), read_json(run_dir / "status.json")
        if not req or not status or req["kind"] != "evaluate" or status["exit_code"] != 0:
            continue
        meta = read_json(one(run_dir / "out", f"logs/run_metadata_{status['file_tag']}.json") or Path("/nonexistent")) or {}
        o = req["options"]
        rows.append({"run_id": run_dir.name, "task": o["task"], "mode": o.get("mode"), "test_set": o.get("test_set"),
                     "title": meta.get("title"), "csv": Path(o["csv"]).name, "started": req["started"],
                     "n_participants": meta.get("n_participants"), "group": req.get("group")})
    rows.sort(key=lambda r: r["run_id"], reverse=True)
    return rows[:limit]


@app.get("/api/health")
def health():
    return {"ok": True, "evaluate_py": EVALUATE.exists(), "gui_built": (GUI_DIST / "index.html").exists()}


# ============================================================
# GUI (the built single-page app)
# ============================================================
@app.get("/{full_path:path}", include_in_schema=False)
def gui(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(404, "Not found.")
    if not (GUI_DIST / "index.html").exists():
        return HTMLResponse("<h1>FigureUS(out)</h1><p>The GUI is not built. In the skill folder run "
                            "<code>npm --prefix gui install</code> and <code>npm --prefix gui run build</code>, "
                            "then start the server again.</p>", status_code=503)
    if full_path:
        target = inside(GUI_DIST, full_path)
        if target.is_file():
            return FileResponse(target)
    return FileResponse(GUI_DIST / "index.html", headers={"Cache-Control": "no-cache"})


def main() -> None:
    ap = argparse.ArgumentParser(description="FigureUS(out) local server (this computer only).")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser")
    ap.add_argument("--jobs-dir", type=Path, help="where uploads and results go (default eval_output/gui_jobs)")
    args = ap.parse_args()
    global JOBS_DIR
    if args.jobs_dir:
        JOBS_DIR = args.jobs_dir.resolve()
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    url = f"http://{HOST}:{args.port}"
    print(f"FigureUS(out) is running at {url}  (this computer only)")
    print("Keep this window open while you use it; press Control-C to stop.")
    if not args.no_browser:
        threading.Timer(1.2, webbrowser.open, args=(url,)).start()
    uvicorn.run(app, host=HOST, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
