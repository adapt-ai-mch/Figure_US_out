// Results of one evaluate.py run: cohort, metrics as evaluate.py reported them, plots, notices, downloads.
import { useEffect, useState } from "react"
import { Download, ExternalLink, FileText, History, Pencil, Plus, Sheet } from "lucide-react"

import { Page } from "@/components/app-chrome"
import { Btn, BtnLink, Field, Note, Progress, Select, TextInput } from "@/components/form"
import { api, ApiError, runAndWait, type MetricRow, type Results, type RunView } from "@/lib/api"
import { go, href } from "@/lib/router"
import { metricName, TASK_BY_KEY, TEST_SET } from "@/lib/tasks"
import { TITLE_MAX } from "@/views/workspace-model"

const message = (e: unknown) => (e instanceof ApiError ? e.message : String(e))
const unitText = (u: string) => u.replace(/\^2\b/g, "²")
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

export function ResultsView({ runId }: { runId: string }) {
  const [view, setView] = useState<RunView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      for (;;) {
        try {
          const v = await api.getRun(runId)
          if (!live) return
          setView(v)
          setError(null)
          if (v.state === "finished") return
        } catch (e) {
          if (live) setError(message(e))
          return
        }
        await new Promise((r) => setTimeout(r, 700))
      }
    })()
    return () => {
      live = false
    }
  }, [runId])

  const results = view?.results
  const accent = view?.options.test_set ? TEST_SET[view.options.test_set].color : undefined
  return (
    <Page accent={results ? accent : undefined}>
      {error && (
        <Note tone="error" title="These results cannot be opened">
          <p>{error}</p>
          <a className="font-medium underline" href={href("/runs")}>
            See the recent runs
          </a>
        </Note>
      )}
      {!view && !error && <p className="text-muted-foreground">Opening the results…</p>}
      {view?.state === "running" && (
        <div className="max-w-xl">
          <Progress
            step={view.progress?.step ?? 1}
            total={view.progress?.total ?? 6}
            label={view.progress?.label ?? "evaluate.py is working"}
          />
        </div>
      )}
      {view?.state === "finished" && !results && (
        <Note tone="error" title="This run has no results">
          <p className="whitespace-pre-line">{view.message || "It was a check, not an evaluation."}</p>
        </Note>
      )}
      {view && results && <ResultsBody view={view} results={results} />}
    </Page>
  )
}

function ResultsBody({ view, results }: { view: RunView; results: Results }) {
  const m = results.meta
  const task = TASK_BY_KEY[m.task]
  const accent = view.options.test_set ? TEST_SET[view.options.test_set].color : "var(--primary)"
  const cohort: [string, number][] = [
    ...(m.n_observations !== m.n_participants ? [[cap(m.observation_unit), m.n_observations] as [string, number]] : []),
    ["Rows in CSV", m.n_rows_csv],
    ["Rows excluded", m.n_rows_excluded],
  ]

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-5">
        <div className="border-l-4 pl-5" style={{ borderColor: accent }}>
          <p className="text-[15px] font-semibold" style={{ color: accent }}>
            {m.test_set}
          </p>
          <TitleEditor view={view} results={results} />
          <p className="mt-1 text-[15px] text-muted-foreground [overflow-wrap:anywhere]">
            {task.label}
            {m.mode ? ` (${m.mode === "fgr" ? "FGR" : "Standard"})` : ""}, {view.options.csv.split("/").pop()}.
            Evaluated {when(view.started)}.
          </p>
        </div>
        <dl className="flex flex-wrap items-end gap-x-10 gap-y-3 rounded-xl border bg-card px-5 py-4">
          <div>
            <dt className="text-sm text-muted-foreground">Total participants</dt>
            <dd className="font-heading text-4xl font-bold leading-none">{m.n_participants}</dd>
          </div>
          {cohort.map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-2xl font-semibold leading-tight">{value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <MetricsTable rows={results.metrics} nBoot={m.n_boot} />
        <PlotViewer runId={view.run_id} figures={results.figures} />
      </div>

      {results.notices.length > 0 && (
        <section aria-labelledby="notices-h" className="flex flex-col gap-3">
          <h2 id="notices-h" className="font-heading text-2xl font-semibold">
            Notices
          </h2>
          {results.notices.map((n) => (
            <Note key={n} tone="warning">
              {n}
            </Note>
          ))}
        </section>
      )}

      <section aria-labelledby="downloads-h" className="flex flex-col gap-4">
        <h2 id="downloads-h" className="font-heading text-2xl font-semibold">
          Downloads
        </h2>
        <div className="flex flex-wrap gap-3">
          <BtnLink variant="default" href={api.zipUrl(view.run_id)} download>
            <Download aria-hidden />
            All results (.zip)
          </BtnLink>
          {results.report_file && (
            <BtnLink href={api.fileUrl(view.run_id, results.report_file, true)} download>
              <FileText aria-hidden />
              Report (.md)
            </BtnLink>
          )}
          {results.metrics_file && (
            <BtnLink href={api.fileUrl(view.run_id, results.metrics_file, true)} download>
              <Sheet aria-hidden />
              Metrics (.csv)
            </BtnLink>
          )}
        </div>
        <details className="rounded-lg border bg-card px-4 py-3">
          <summary className="cursor-pointer font-medium">Every file this run saved ({results.files.length})</summary>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {results.files.map((f) => (
              <li key={f.file}>
                <a className="text-primary underline-offset-2 hover:underline [overflow-wrap:anywhere]" href={api.fileUrl(view.run_id, f.file, true)} download>
                  {f.file}
                </a>{" "}
                <span className="text-muted-foreground">{kb(f.bytes)}</span>
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section aria-labelledby="details-h" className="flex flex-col gap-3">
        <h2 id="details-h" className="font-heading text-2xl font-semibold">
          Run record
        </h2>
        <dl className="grid max-w-3xl grid-cols-1 gap-x-8 gap-y-2 text-[15px] sm:grid-cols-[auto_minmax(0,1fr)]">
          <Detail label="Units">{m.units}</Detail>
          <Detail label="Confidence intervals">
            {m.ci_method}, {m.n_boot} replicates, seed {m.random_seed}
          </Detail>
          <Detail label="Participants linked by">{m.participant_link}</Detail>
          {m.column_mapping && (
            <Detail label="Columns used">
              {Object.entries(m.column_mapping)
                .map(([name, col]) => `${name} = ${col}`)
                .join(", ")}
            </Detail>
          )}
          <Detail label="Run">{m.run_name}</Detail>
        </dl>
        {results.report && (
          <details className="max-w-4xl rounded-lg border bg-card px-4 py-3">
            <summary className="cursor-pointer font-medium">Report text (Markdown)</summary>
            <pre className="mt-3 max-h-[480px] overflow-auto text-[13px] leading-relaxed whitespace-pre-wrap">{results.report}</pre>
          </details>
        )}
      </section>

      <div className="flex flex-wrap gap-3 border-t pt-8">
        <BtnLink
          variant="default"
          href={href(
            `/task/${m.task}?${m.mode ? `mode=${m.mode}&` : ""}${view.options.test_set ? `test=${view.options.test_set}` : ""}`,
          )}
        >
          <Plus aria-hidden />
          Evaluate another CSV
        </BtnLink>
        <BtnLink href={href("/runs")}>
          <History aria-hidden />
          Recent runs
        </BtnLink>
      </div>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </>
  )
}

function TitleEditor({ view, results }: { view: RunView; results: Results }) {
  const title = results.meta.title ?? ""
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState<RunView["progress"] | false>(false)
  const [error, setError] = useState<string | null>(null)
  const fallback = `${TASK_BY_KEY[results.meta.task].label} results`
  const length = draft.trim().length

  async function save() {
    const next = draft.trim().split(/\s+/).join(" ")
    if (next === title) return setEditing(false)
    setSaving(null)
    setError(null)
    try {
      const v = await runAndWait(view.job_id, "evaluate", { ...view.options, title: next || null }, setSaving, results.meta.cohort_id)
      if (v.status === "ok") go(`/results/${v.run_id}`)
      else setError(v.message || "evaluate.py stopped.")
    } catch (e) {
      setError(message(e))
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="font-heading text-[clamp(2rem,4.2vw,3rem)] font-bold leading-[1.08] tracking-[-0.02em] [overflow-wrap:anywhere]">
          {title || fallback}
        </h1>
        <Btn variant="ghost" className="h-10 px-3 text-sm" onClick={() => (setDraft(title), setEditing(true))}>
          <Pencil aria-hidden className="size-4" />
          {title ? "Edit title" : "Add a title"}
        </Btn>
      </div>
    )
  }

  return (
    <form
      className="mt-1 flex max-w-2xl flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <Field
        htmlFor="edit-title"
        label="Title"
        help="Saving runs the evaluation again with the same seed, so every number stays the same; the report and the run record get the new title."
        error={length > TITLE_MAX ? `Shorten the title to ${TITLE_MAX} characters or fewer.` : error}
      >
        <TextInput
          id="edit-title"
          autoFocus
          onFocus={(e) => e.target.select()}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-12 font-heading text-xl font-semibold"
          aria-describedby="edit-title-count"
        />
        <span id="edit-title-count" className="self-end text-sm text-muted-foreground">
          {length} of {TITLE_MAX} characters
        </span>
      </Field>
      {saving !== false ? (
        <Progress step={saving?.step ?? 1} total={saving?.total ?? 6} label={saving?.label ?? "Saving the title"} />
      ) : (
        <div className="flex gap-3">
          <Btn type="submit" disabled={length > TITLE_MAX}>
            Save title
          </Btn>
          <Btn variant="outline" onClick={() => setEditing(false)}>
            Cancel
          </Btn>
        </div>
      )}
    </form>
  )
}

function MetricsTable({ rows, nBoot }: { rows: MetricRow[]; nBoot: number }) {
  const groups = [...new Set(rows.map((r) => r.group))]
  return (
    <section aria-labelledby="metrics-h" className="flex min-w-0 flex-col gap-3">
      <h2 id="metrics-h" className="font-heading text-2xl font-semibold">
        Metrics
      </h2>
      <p className="text-sm text-muted-foreground">
        As evaluate.py reported them: estimates to 2 decimal places, counts as whole numbers, 95% CIs from {nBoot}{" "}
        participant bootstrap replicates written [lower - upper].
      </p>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-left text-[15px]">
          <caption className="sr-only">Metrics with 95% confidence intervals</caption>
          <thead className="border-b bg-muted/70 text-sm">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-semibold">Metric</th>
              <th scope="col" className="px-4 py-2.5 text-right font-semibold">Estimate</th>
              <th scope="col" className="px-4 py-2.5 text-right font-semibold">95% CI</th>
              <th scope="col" className="px-4 py-2.5 font-semibold">Unit</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g} className="divide-y">
              {groups.length > 1 && (
                <tr className="bg-secondary/40">
                  <th scope="rowgroup" colSpan={4} className="px-4 py-2 text-sm font-semibold text-primary">
                    {g}
                  </th>
                </tr>
              )}
              {rows
                .filter((r) => r.group === g)
                .map((r) => (
                  <tr key={`${g}-${r.metric}`}>
                    <th scope="row" className="px-4 py-2.5 font-medium" title={r.metric}>
                      {metricName(r.metric)}
                      {r.note && <span className="block text-[13px] font-normal text-muted-foreground">{r.note}</span>}
                    </th>
                    <td className="px-4 py-2.5 text-right font-semibold whitespace-nowrap tabular-nums">{r.estimate_reported}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums">{r.ci_95_reported || "—"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{unitText(r.unit)}</td>
                  </tr>
                ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  )
}

function PlotViewer({ runId, figures }: { runId: string; figures: Results["figures"] }) {
  const [index, setIndex] = useState(0)
  const f = figures[Math.min(index, figures.length - 1)]
  return (
    <section aria-labelledby="plots-h" className="flex min-w-0 flex-col gap-3">
      <h2 id="plots-h" className="font-heading text-2xl font-semibold">
        Plots
      </h2>
      {!f ? (
        <p className="text-muted-foreground">This run saved no plots.</p>
      ) : (
        <>
          <Field htmlFor="plot" label={`Plot to show (${figures.length})`}>
            <Select id="plot" value={index} onChange={(e) => setIndex(Number(e.target.value))}>
              {figures.map((fig, i) => (
                <option key={fig.file} value={i}>
                  {fig.title}
                </option>
              ))}
            </Select>
          </Field>
          <figure className="flex flex-col gap-2">
            <div className="flex min-h-[320px] items-center justify-center overflow-hidden rounded-xl border bg-white p-2">
              <img
                key={f.file}
                src={api.fileUrl(runId, f.file)}
                alt={f.title}
                className="h-auto max-h-[72vh] w-auto max-w-full object-contain"
              />
            </div>
            <figcaption className="sr-only">{f.title}</figcaption>
          </figure>
          <div className="flex flex-wrap gap-3">
            <BtnLink href={api.fileUrl(runId, f.file, true)} download>
              <Download aria-hidden />
              Download this plot (.png)
            </BtnLink>
            <BtnLink variant="ghost" href={api.fileUrl(runId, f.file)} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden />
              Open full size
            </BtnLink>
          </div>
        </>
      )}
    </section>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`)
