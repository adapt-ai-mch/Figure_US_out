// Results of one or two evaluate.py runs (internal and external test set) side by side: cohorts, metrics
// as evaluate.py reported them, plots, notices, downloads. Nothing here calculates a value; it lines up text.
import { useEffect, useState } from "react"
import { Download, ExternalLink, FileText, History, Pencil, Plus, Sheet } from "lucide-react"

import { Page, TestSetIcon } from "@/components/app-chrome"
import { Btn, BtnLink, Field, Note, Progress, Select, TextInput } from "@/components/form"
import { api, ApiError, newGroup, runAndWait, type MetricRow, type Results, type RunView } from "@/lib/api"
import { go, href } from "@/lib/router"
import { metricName, TASK_BY_KEY, TEST_SET } from "@/lib/tasks"
import { TITLE_MAX } from "@/views/workspace-model"

type Run = { view: RunView; results: Results; testSet: "internal" | "external" }

const message = (e: unknown) => (e instanceof ApiError ? e.message : String(e))
const unitText = (u: string) => u.replace(/\^2\b/g, "²")
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
const plotKind = (title: string) => title.replace(/^(Internal|External) Test:\s*/, "")
const csvName = (r: Run) => r.view.options.csv.split("/").pop()

export function ResultsView({ runIds }: { runIds: string[] }) {
  const [views, setViews] = useState<Record<string, RunView>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      for (;;) {
        try {
          const got = await Promise.all(runIds.map((id) => api.getRun(id)))
          if (!live) return
          setViews(Object.fromEntries(got.map((v) => [v.run_id, v])))
          setError(null)
          if (got.every((v) => v.state === "finished")) return
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
  }, [runIds])

  const ordered = runIds.map((id) => views[id]).filter(Boolean)
  const running = ordered.filter((v) => v.state === "running")
  const runs: Run[] = ordered
    .filter((v) => v.results)
    .map((v) => ({ view: v, results: v.results!, testSet: v.options.test_set ?? "internal" }))
    .sort((a, b) => (a.testSet === b.testSet ? 0 : a.testSet === "internal" ? -1 : 1))
  const empty = ordered.filter((v) => v.state === "finished" && !v.results)
  const accent = runs.length === 1 ? TEST_SET[runs[0].testSet].color : undefined

  return (
    <Page accent={accent}>
      {error && (
        <Note tone="error" title="These results cannot be opened">
          <p>{error}</p>
          <a className="font-medium underline" href={href("/runs")}>
            See the recent runs
          </a>
        </Note>
      )}
      {!ordered.length && !error && <p className="text-muted-foreground">Opening the results…</p>}
      {running.map((v) => (
        <div key={v.run_id} className="mb-6 max-w-xl">
          <Progress step={v.progress?.step ?? 1} total={v.progress?.total ?? 6} label={v.progress?.label ?? "evaluate.py is working"} />
        </div>
      ))}
      {empty.map((v) => (
        <Note key={v.run_id} tone="error" title="This run has no results" className="mb-6">
          <p className="whitespace-pre-line">{v.message || "It was a check, not an evaluation."}</p>
        </Note>
      ))}
      {runs.length > 0 && !running.length && <ResultsBody runs={runs} />}
    </Page>
  )
}

function TestSetName({ run, className }: { run: Run; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-semibold ${className ?? ""}`} style={{ color: TEST_SET[run.testSet].color }}>
      <TestSetIcon testSet={run.testSet} className="size-[18px]" />
      {TEST_SET[run.testSet].label}
    </span>
  )
}

function ResultsBody({ runs }: { runs: Run[] }) {
  const m = runs[0].results.meta
  const task = TASK_BY_KEY[m.task]

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-[15px]">
            {runs.map((r) => (
              <TestSetName key={r.view.run_id} run={r} />
            ))}
          </p>
          <TitleEditor runs={runs} />
          <p className="mt-1 text-[15px] text-muted-foreground [overflow-wrap:anywhere]">
            {task.label}
            {m.mode ? ` (${m.mode === "fgr" ? "FGR" : "Standard"})` : ""}.{" "}
            {runs.map((r) => `${TEST_SET[r.testSet].label}: ${csvName(r)}`).join("; ")}. Evaluated {when(runs[0].view.started)}.
          </p>
        </div>
        <div className={runs.length > 1 ? "grid grid-cols-1 gap-4 md:grid-cols-2" : "grid grid-cols-1"}>
          {runs.map((r) => (
            <CohortCard key={r.view.run_id} run={r} />
          ))}
        </div>
      </header>

      <MetricsTable runs={runs} />
      <PlotViewer runs={runs} />

      {runs.some((r) => r.results.notices.length) && (
        <section aria-labelledby="notices-h" className="flex flex-col gap-3">
          <h2 id="notices-h" className="font-heading text-2xl font-semibold">
            Notices
          </h2>
          {runs.flatMap((r) =>
            r.results.notices.map((n) => (
              <Note key={`${r.view.run_id}-${n}`} tone="warning" title={runs.length > 1 ? TEST_SET[r.testSet].label : undefined}>
                {n}
              </Note>
            )),
          )}
        </section>
      )}

      <section aria-labelledby="downloads-h" className="flex flex-col gap-4">
        <h2 id="downloads-h" className="font-heading text-2xl font-semibold">
          Downloads
        </h2>
        {runs.map((r) => (
          <div key={r.view.run_id} className="flex flex-col gap-3">
            {runs.length > 1 && <TestSetName run={r} className="text-[15px]" />}
            <div className="flex flex-wrap gap-3">
              <BtnLink variant="default" href={api.zipUrl(r.view.run_id)} download>
                <Download aria-hidden />
                All results (.zip)
              </BtnLink>
              {r.results.report_file && (
                <BtnLink href={api.fileUrl(r.view.run_id, r.results.report_file, true)} download>
                  <FileText aria-hidden />
                  Report (.md)
                </BtnLink>
              )}
              {r.results.metrics_file && (
                <BtnLink href={api.fileUrl(r.view.run_id, r.results.metrics_file, true)} download>
                  <Sheet aria-hidden />
                  Metrics (.csv)
                </BtnLink>
              )}
            </div>
            <details className="rounded-lg border bg-card px-4 py-3">
              <summary className="cursor-pointer font-medium">Every file this run saved ({r.results.files.length})</summary>
              <ul className="mt-3 flex flex-col gap-1 text-sm">
                {r.results.files.map((f) => (
                  <li key={f.file}>
                    <a
                      className="text-primary underline-offset-2 hover:underline [overflow-wrap:anywhere]"
                      href={api.fileUrl(r.view.run_id, f.file, true)}
                      download
                    >
                      {f.file}
                    </a>{" "}
                    <span className="text-muted-foreground">{kb(f.bytes)}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        ))}
      </section>

      <section aria-labelledby="details-h" className="flex flex-col gap-4">
        <h2 id="details-h" className="font-heading text-2xl font-semibold">
          Run record
        </h2>
        {runs.map((r) => {
          const rm = r.results.meta
          return (
            <div key={r.view.run_id} className="flex flex-col gap-2">
              {runs.length > 1 && <TestSetName run={r} className="text-[15px]" />}
              <dl className="grid max-w-3xl grid-cols-1 gap-x-8 gap-y-2 text-[15px] sm:grid-cols-[auto_minmax(0,1fr)]">
                <Detail label="Units">{rm.units}</Detail>
                <Detail label="Confidence intervals">
                  {rm.ci_method}, {rm.n_boot} replicates, seed {rm.random_seed}
                </Detail>
                <Detail label="Participants linked by">{rm.participant_link}</Detail>
                {rm.column_mapping && (
                  <Detail label="Columns used">
                    {Object.entries(rm.column_mapping)
                      .map(([name, col]) => `${name} = ${col}`)
                      .join(", ")}
                  </Detail>
                )}
                <Detail label="Run">{rm.run_name}</Detail>
              </dl>
              {r.results.report && (
                <details className="max-w-4xl rounded-lg border bg-card px-4 py-3">
                  <summary className="cursor-pointer font-medium">Report text (Markdown)</summary>
                  <pre className="mt-3 max-h-[480px] overflow-auto text-[13px] leading-relaxed whitespace-pre-wrap">{r.results.report}</pre>
                </details>
              )}
            </div>
          )
        })}
      </section>

      <div className="flex flex-wrap gap-3 border-t pt-8">
        <BtnLink variant="default" href={href(`/task/${m.task}${m.mode ? `?mode=${m.mode}` : ""}`)}>
          <Plus aria-hidden />
          Evaluate other CSVs
        </BtnLink>
        <BtnLink href={href("/runs")}>
          <History aria-hidden />
          Recent runs
        </BtnLink>
      </div>
    </div>
  )
}

function CohortCard({ run }: { run: Run }) {
  const m = run.results.meta
  const rows: [string, number][] = [
    ...(m.n_observations !== m.n_participants ? [[cap(m.observation_unit), m.n_observations] as [string, number]] : []),
    ["Rows in CSV", m.n_rows_csv],
    ["Rows excluded", m.n_rows_excluded],
  ]
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-t-4 bg-card px-5 py-4" style={{ borderTopColor: TEST_SET[run.testSet].color }}>
      <TestSetName run={run} className="text-[15px]" />
      <dl className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <dt className="text-sm text-muted-foreground">Total participants</dt>
          <dd className="font-heading text-4xl font-bold leading-none">{m.n_participants}</dd>
        </div>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-2xl font-semibold leading-tight">{value}</dd>
          </div>
        ))}
      </dl>
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

/** One title for all the runs shown; saving re-runs each with the same seed and its confirmed cohort. */
function TitleEditor({ runs }: { runs: Run[] }) {
  const title = runs[0].results.meta.title ?? ""
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState<RunView["progress"] | false>(false)
  const [error, setError] = useState<string | null>(null)
  const fallback = `${TASK_BY_KEY[runs[0].results.meta.task].label} results`
  const length = draft.trim().length

  async function save() {
    const next = draft.trim().split(/\s+/).join(" ")
    if (next === title) return setEditing(false)
    setSaving(null)
    setError(null)
    const group = newGroup()
    const ids: string[] = []
    try {
      for (const r of runs) {
        const v = await runAndWait(
          r.view.job_id,
          "evaluate",
          { ...r.view.options, title: next || null },
          setSaving,
          r.results.meta.cohort_id,
          group,
        )
        if (v.status !== "ok") {
          setError(`${TEST_SET[r.testSet].label}: ${v.message || "evaluate.py stopped."}`)
          return
        }
        ids.push(v.run_id)
      }
      go(`/results/${ids.join(",")}`)
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
        help={`Saving runs the evaluation${runs.length > 1 ? "s" : ""} again with the same seed, so every number stays the same; the reports and run records get the new title.`}
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

function MetricsTable({ runs }: { runs: Run[] }) {
  const key = (r: MetricRow) => `${r.group}\u0000${r.metric}`
  const lookups = runs.map((r) => new Map(r.results.metrics.map((row) => [key(row), row])))
  const rows: MetricRow[] = []
  const seen = new Set<string>()
  for (const r of runs) {
    for (const row of r.results.metrics) {
      if (!seen.has(key(row))) {
        seen.add(key(row))
        rows.push(row)
      }
    }
  }
  const groups = [...new Set(rows.map((r) => r.group))]
  const nBoot = runs[0].results.meta.n_boot
  const cols = 2 + runs.length * 2

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
          <caption className="sr-only">Metrics with 95% confidence intervals{runs.length > 1 ? ", internal and external test set" : ""}</caption>
          <thead className="border-b bg-muted/70 text-sm">
            {runs.length > 1 && (
              <tr>
                <td />
                {runs.map((r) => (
                  <th
                    key={r.view.run_id}
                    scope="colgroup"
                    colSpan={2}
                    className="border-l px-4 pt-2.5 text-center font-semibold"
                    style={{ color: TEST_SET[r.testSet].color }}
                  >
                    {TEST_SET[r.testSet].label}
                  </th>
                ))}
                <td />
              </tr>
            )}
            <tr>
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Metric
              </th>
              {runs.map((r) => (
                <FragmentHeads key={r.view.run_id} />
              ))}
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Unit
              </th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g} className="divide-y">
              {groups.length > 1 && (
                <tr className="bg-secondary/40">
                  <th scope="rowgroup" colSpan={cols} className="px-4 py-2 text-sm font-semibold text-primary">
                    {g}
                  </th>
                </tr>
              )}
              {rows
                .filter((r) => r.group === g)
                .map((row) => {
                  const cells = lookups.map((l) => l.get(key(row)))
                  const notes = cells.map((c) => c?.note ?? "")
                  const sameNote = notes.every((n) => n === notes[0])
                  const unit = cells.find((c) => c?.unit)?.unit ?? ""
                  return (
                    <tr key={key(row)}>
                      <th scope="row" className="min-w-[15rem] px-4 py-2.5 font-medium" title={row.metric}>
                        {metricName(row.metric)}
                        {sameNote
                          ? notes[0] && <span className="block text-[13px] font-normal text-muted-foreground">{notes[0]}</span>
                          : notes.map(
                              (n, i) =>
                                n && (
                                  <span key={i} className="block text-[13px] font-normal text-muted-foreground">
                                    {TEST_SET[runs[i].testSet].label}: {n}
                                  </span>
                                ),
                            )}
                      </th>
                      {cells.map((c, i) => (
                        <FragmentCells key={runs[i].view.run_id} row={c} />
                      ))}
                      <td className="px-4 py-2.5 text-muted-foreground">{unitText(unit)}</td>
                    </tr>
                  )
                })}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  )
}

function FragmentHeads() {
  return (
    <>
      <th scope="col" className="border-l px-4 py-2.5 text-right font-semibold">
        Estimate
      </th>
      <th scope="col" className="px-4 py-2.5 text-right font-semibold">
        95% CI
      </th>
    </>
  )
}

function FragmentCells({ row }: { row: MetricRow | undefined }) {
  return (
    <>
      <td className="border-l px-4 py-2.5 text-right font-semibold whitespace-nowrap tabular-nums">{row ? row.estimate_reported : "—"}</td>
      <td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums">{row?.ci_95_reported || "—"}</td>
    </>
  )
}

function PlotViewer({ runs }: { runs: Run[] }) {
  const kinds: string[] = []
  for (const r of runs) for (const f of r.results.figures) if (!kinds.includes(plotKind(f.title))) kinds.push(plotKind(f.title))
  const [index, setIndex] = useState(0)
  const kind = kinds[Math.min(index, kinds.length - 1)]

  return (
    <section aria-labelledby="plots-h" className="flex min-w-0 flex-col gap-3">
      <h2 id="plots-h" className="font-heading text-2xl font-semibold">
        Plots
      </h2>
      {!kind ? (
        <p className="text-muted-foreground">These runs saved no plots.</p>
      ) : (
        <>
          <div className="max-w-xl">
            <Field htmlFor="plot" label={`Plot to show (${kinds.length})`}>
              <Select id="plot" value={index} onChange={(e) => setIndex(Number(e.target.value))}>
                {kinds.map((k, i) => (
                  <option key={k} value={i}>
                    {k}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className={runs.length > 1 ? "grid grid-cols-1 gap-6 xl:grid-cols-2" : "grid grid-cols-1"}>
            {runs.map((r) => {
              const f = r.results.figures.find((fig) => plotKind(fig.title) === kind)
              return (
                <figure key={r.view.run_id} className="flex min-w-0 flex-col gap-2">
                  {runs.length > 1 && <TestSetName run={r} className="text-[15px]" />}
                  <div className="flex min-h-[280px] items-center justify-center overflow-hidden rounded-xl border bg-white p-2">
                    {f ? (
                      <img
                        key={f.file}
                        src={api.fileUrl(r.view.run_id, f.file)}
                        alt={f.title}
                        className="h-auto max-h-[72vh] w-auto max-w-full object-contain"
                      />
                    ) : (
                      <p className="px-4 text-center text-muted-foreground">evaluate.py did not make this plot for the {TEST_SET[r.testSet].label.toLowerCase()} set.</p>
                    )}
                  </div>
                  <figcaption className="sr-only">{f?.title ?? kind}</figcaption>
                  {f && (
                    <div className="flex flex-wrap gap-3">
                      <BtnLink href={api.fileUrl(r.view.run_id, f.file, true)} download>
                        <Download aria-hidden />
                        Download (.png)
                      </BtnLink>
                      <BtnLink variant="ghost" href={api.fileUrl(r.view.run_id, f.file)} target="_blank" rel="noreferrer">
                        <ExternalLink aria-hidden />
                        Open full size
                      </BtnLink>
                    </div>
                  )}
                </figure>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`)
