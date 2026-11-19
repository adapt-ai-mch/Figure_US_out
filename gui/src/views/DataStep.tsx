// Step 1: choose the predictions CSV (files, a folder, or a path on this computer) and match its columns.
import { useState, type ChangeEvent } from "react"
import { FileSpreadsheet, FolderOpen, FolderUp, Link2, RotateCcw, Upload } from "lucide-react"

import { Btn, Field, Note, Select, TextInput } from "@/components/form"
import { api, ApiError, type CsvSummary, type Job } from "@/lib/api"
import type { Task } from "@/lib/tasks"
import { RECORD, VISIT, type Problems } from "@/views/workspace-model"

type Props = {
  task: Task
  job: Job | null
  csv: string | null
  summary: CsvSummary | null
  mapping: Record<string, string>
  participant: string
  problems: Problems
  /** evaluate.py's message when it stopped on the columns (missing column, or a choice about them). */
  columnMessage: string | null
  onJob: (job: Job) => void
  onCsv: (name: string) => void
  onReset: () => void
  onMapping: (name: string, column: string) => void
  onParticipant: (value: string) => void
}

const folderProps = { webkitdirectory: "", directory: "" } as object

export function DataStep(p: Props) {
  const [path, setPath] = useState("")
  const [upload, setUpload] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function send(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ""
    if (!files.length) return
    setError(null)
    setUpload(0)
    try {
      p.onJob(await api.uploadFiles(files, setUpload))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setUpload(null)
    }
  }

  async function openPath() {
    setError(null)
    try {
      p.onJob(await api.openPath(path))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  if (!p.job) {
    const csvInput = (
      <label className="relative inline-flex">
        <input type="file" accept=".csv,text/csv" className="peer sr-only" onChange={send} disabled={upload !== null} />
        <span className={pickerClass(!p.task.usesFiles)}>
          <FileSpreadsheet aria-hidden className="size-[18px]" />
          {p.task.usesFiles ? "Choose only the CSV" : "Choose the CSV file"}
        </span>
      </label>
    )
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold">
            <Upload aria-hidden className="size-[18px] text-primary" />
            {p.task.usesFiles ? "Choose the folder with the CSV and its files" : "Choose the predictions CSV"}
          </h3>
          <p className="max-w-[66ch] text-sm text-muted-foreground">
            {p.task.usesFiles
              ? `The CSV lists ${p.task.key === "segmentation" ? "mask and image" : "XML and video"} files. Choose the folder that holds them, so their relative paths still work. Choose only the CSV when it lists full paths (starting with /).`
              : `It needs ${p.task.columns.filter((c) => !c.optional).map((c) => c.name).join(", ")}; columns with other names can be matched once it is open.`}{" "}
            A copy goes into eval_output/gui_jobs on this computer and nowhere else.
          </p>
          <div className="flex flex-wrap gap-3">
            {p.task.usesFiles && (
              <label className="relative inline-flex">
                <input type="file" multiple className="peer sr-only" onChange={send} disabled={upload !== null} {...folderProps} />
                <span className={pickerClass(true)}>
                  <FolderUp aria-hidden className="size-[18px]" />
                  Choose the folder
                </span>
              </label>
            )}
            {csvInput}
          </div>
          {upload !== null && (
            <div role="status" aria-live="polite" className="flex max-w-md flex-col gap-1.5 text-sm">
              <span>Copying the files… {Math.round(upload * 100)}%</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${upload * 100}%` }} />
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 text-sm text-muted-foreground" aria-hidden>
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void openPath()
          }}
        >
          <Field
            htmlFor="csv-path"
            label={
              <span className="flex items-center gap-2">
                <Link2 aria-hidden className="size-[18px] text-primary" />
                Use the CSV where it is
              </span>
            }
            help="Nothing is copied; files the CSV lists are read from their own folder. In Finder, select the CSV and press Option-Command-C to copy its path."
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <TextInput
                id="csv-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/Users/you/Documents/study/predictions.csv"
                spellCheck={false}
                autoComplete="off"
              />
              <Btn type="submit" variant="outline" disabled={!path.trim()} className="shrink-0">
                Use this file
              </Btn>
            </div>
          </Field>
        </form>
        {error && <Note tone="error">{error}</Note>}
      </div>
    )
  }

  const mappedCols = new Set(Object.values(p.mapping).filter(Boolean))
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-muted/50 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          {p.job.source === "path" ? (
            <FolderOpen aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
          ) : (
            <FileSpreadsheet aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
          )}
          <div className="flex min-w-0 flex-col [overflow-wrap:anywhere]">
            <span className="font-semibold">{p.csv ?? "Choose the CSV below"}</span>
            <span className="text-sm text-muted-foreground">
              {p.summary ? `${p.summary.rows} rows, ${p.summary.columns.length} columns. ` : ""}
              {p.job.source === "path"
                ? `Used where it is, in ${p.job.folder}.`
                : `${p.job.n_files} ${p.job.n_files === 1 ? "file" : "files"} copied into this computer's job folder.`}
            </span>
          </div>
        </div>
        <Btn variant="ghost" onClick={p.onReset} className="h-10 px-3 text-sm">
          <RotateCcw aria-hidden />
          Choose another CSV
        </Btn>
      </div>

      {p.job.csv_files.length > 1 && (
        <Field htmlFor="csv-choice" label="Which CSV holds the predictions?" required>
          <Select id="csv-choice" value={p.csv ?? ""} onChange={(e) => p.onCsv(e.target.value)}>
            <option value="" disabled>
              Choose a CSV
            </option>
            {p.job.csv_files.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {p.summary && (
        <>
          <Field
            group
            label="Match the columns"
            help="evaluate.py looks for these names. Pick the CSV column that holds each one; the CSV itself is not changed."
            error={p.problems.columns ?? p.columnMessage}
          >
            <div className="flex flex-col divide-y rounded-lg border bg-card" id="field-columns">
              {p.task.columns.map((c) => {
                const id = `col-${c.name}`
                const err = p.problems[`col:${c.name}`]
                return (
                  <div key={c.name} className="grid grid-cols-1 items-center gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:gap-6">
                    <label htmlFor={id} className="flex flex-col">
                      <span className="font-mono text-[14px] font-semibold text-primary">
                        {c.name}
                        {c.optional && <span className="font-sans font-normal text-muted-foreground"> (optional)</span>}
                      </span>
                      <span className="text-sm text-muted-foreground">{c.holds}</span>
                    </label>
                    <div className="flex flex-col gap-1">
                      <Select
                        id={id}
                        value={p.mapping[c.name] ?? ""}
                        onChange={(e) => p.onMapping(c.name, e.target.value)}
                        aria-invalid={!!err || undefined}
                      >
                        <option value="">{c.optional ? "None" : "Choose a column"}</option>
                        {p.summary!.columns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </Select>
                      {err && <span className="text-sm font-medium text-destructive">{err}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </Field>

          {p.task.key === "classification" ? (
            <p className="text-sm text-muted-foreground">
              Participants: in Standard mode each record_id is one participant; in FGR mode the participant is read
              from record_id values like 001_32+5.
            </p>
          ) : (
            <Field
              htmlFor="participant"
              label="How do rows link to participants?"
              help="Confidence intervals resample participants, so rows from one person stay together."
              error={p.problems.participant}
              required
            >
              <div id="field-participant_col">
                <Select
                  id="participant"
                  value={p.participant}
                  onChange={(e) => p.onParticipant(e.target.value)}
                  aria-invalid={!!p.problems.participant || undefined}
                >
                  <option value="" disabled>
                    Choose
                  </option>
                  <option value={RECORD}>Each record_id is one participant</option>
                  <option value={VISIT}>record_id holds visits like 001_32+5 (participant 001)</option>
                  <optgroup label="Or a column that names the participant">
                    {p.summary.columns
                      .filter((col) => !mappedCols.has(col) || col === p.participant)
                      .map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                  </optgroup>
                </Select>
              </div>
            </Field>
          )}
        </>
      )}
    </div>
  )
}

function pickerClass(primary: boolean) {
  return [
    "inline-flex h-11 cursor-pointer items-center gap-2 rounded-lg border px-5 text-[15px] font-semibold transition-colors",
    "peer-focus-visible:ring-3 peer-focus-visible:ring-ring/40 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
    primary
      ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/85"
      : "border-border bg-background text-foreground hover:bg-muted",
  ].join(" ")
}
