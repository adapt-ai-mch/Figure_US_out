// Client for the FigureUS(out) local server (server/app.py, http://127.0.0.1:8765).
// The server runs evaluate.py; this file only moves requests and the saved results.

import type { TaskKey } from "@/lib/tasks"

/** Sent with every request; the server refuses changes without it (other web pages cannot add it). */
const HEADERS = { "x-figureus": "1" }

export class ApiError extends Error {}

export type Job = {
  job_id: string
  source: "upload" | "path"
  csv_files: string[]
  n_files: number
  folder?: string
}

export type CsvSummary = { name: string; columns: string[]; rows: number }

export type Options = {
  task: TaskKey
  csv: string
  test_set: "internal" | "external" | null
  title: string | null
  columns: Record<string, string>
  participant_col: string | null
  id_format: "plain" | "visit"
  mode: "standard" | "fgr" | null
  positive_label: string | null
  negative_label: string | null
  prob_confirmed: boolean
  dca_min: number | null
  dca_max: number | null
  unit: string | null
  repeated_measures: "participant-mean" | "all-pairs-anova" | null
  empty_both: "exclude" | "one" | null
  frame_offset: number
  exclude_invalid: boolean
}

export type Cohort = {
  total_participants: number
  observations: number
  observation_unit: string
  rows_in_csv: number
  rows_excluded: number
  excluded_csv_lines: number[]
  notices: string[]
  column_mapping: Record<string, string>
  cohort_id: string
}

export type Issue = { csv_line: string; column: string; issue: string; detail: string }

export type MetricRow = {
  group: string
  metric: string
  estimate_reported: string
  ci_95_reported: string
  unit: string
  n_boot_contributed: string
  n_boot_requested: string
  note: string
}

export type Results = {
  meta: {
    run_name: string
    test_set: string
    title: string | null
    task: TaskKey
    mode: string | null
    units: string
    n_participants: number
    n_observations: number
    observation_unit: string
    n_rows_csv: number
    n_rows_excluded: number
    random_seed: number
    n_boot: number
    ci_method: string
    cohort_id: string
    column_mapping: Record<string, string> | null
    participant_link: string
  }
  metrics: MetricRow[]
  figures: { file: string; title: string }[]
  notices: string[]
  report: string
  report_file: string | null
  metrics_file: string | null
  files: { file: string; bytes: number }[]
}

export type RunStatus = "ok" | "error" | "needs_input" | "retry" | "missing_column" | "invalid"

export type RunView = {
  run_id: string
  job_id: string
  kind: "check" | "evaluate"
  options: Options
  started: string
  state: "running" | "finished"
  progress?: { step: number; total: number; label: string } | null
  exit_code?: number
  status?: RunStatus
  message?: string
  field?: string | null
  log_tail?: string[]
  issues?: { total: number; rows_affected: number; rows: Issue[]; sheet: string }
  cohort?: Cohort
  results?: Results
  finished?: string
}

export type RecentRun = {
  run_id: string
  task: TaskKey
  mode: string | null
  test_set: "internal" | "external"
  title: string | null
  csv: string
  started: string
  n_participants: number | null
}

const SERVER_DOWN =
  "The FigureUS(out) server is not answering. Start it again (see the README), then try once more."

function detail(body: unknown, fallback: string): string {
  const d = (body as { detail?: unknown })?.detail
  if (typeof d === "string") return d
  if (Array.isArray(d)) return d.map((e) => (e as { msg?: string }).msg ?? "").join("; ")
  return fallback
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let r: Response
  try {
    r = await fetch(path, { ...init, headers: { ...HEADERS, ...init.headers } })
  } catch {
    throw new ApiError(SERVER_DOWN)
  }
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new ApiError(detail(body, `The server answered ${r.status}.`))
  return body as T
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

/** Files from a file or folder picker; folder files keep their relative paths. */
function uploadFiles(files: File[], onProgress: (fraction: number) => void): Promise<Job> {
  const form = new FormData()
  for (const f of files) form.append("files", f, f.webkitRelativePath || f.name)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", "/api/jobs/upload")
    xhr.setRequestHeader("x-figureus", "1")
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onerror = () => reject(new ApiError(SERVER_DOWN))
    xhr.onload = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Job)
      else reject(new ApiError(detail(body, `The server answered ${xhr.status}.`)))
    }
    xhr.send(form)
  })
}

export const api = {
  health: () => call<{ ok: boolean }>("/api/health"),
  uploadFiles,
  openPath: (path: string) => call<Job>("/api/jobs/path", json({ path })),
  csvSummary: (job: string, name: string) =>
    call<CsvSummary>(`/api/jobs/${job}/csv?name=${encodeURIComponent(name)}`),
  labels: (job: string, name: string, column: string) =>
    call<{ values: string[] | null }>(
      `/api/jobs/${job}/labels?name=${encodeURIComponent(name)}&column=${encodeURIComponent(column)}`,
    ),
  startRun: (job: string, kind: "check" | "evaluate", options: Options, cohortId?: string) =>
    call<{ run_id: string }>(`/api/jobs/${job}/runs`, json({ kind, options, cohort_id: cohortId ?? null })),
  getRun: (runId: string) => call<RunView>(`/api/runs/${runId}`),
  recentRuns: () => call<RecentRun[]>("/api/runs"),
  fileUrl: (runId: string, file: string, download = false) =>
    `/api/runs/${runId}/files/${file.split("/").map(encodeURIComponent).join("/")}${download ? "?download=true" : ""}`,
  zipUrl: (runId: string) => `/api/runs/${runId}/download`,
}

/** Start a run and wait for it, reporting progress lines as they come. */
export async function runAndWait(
  job: string,
  kind: "check" | "evaluate",
  options: Options,
  onProgress: (p: RunView["progress"]) => void,
  cohortId?: string,
): Promise<RunView> {
  const { run_id } = await api.startRun(job, kind, options, cohortId)
  for (;;) {
    const v = await api.getRun(run_id)
    if (v.state === "finished") return v
    onProgress(v.progress ?? null)
    await new Promise((r) => setTimeout(r, 500))
  }
}
