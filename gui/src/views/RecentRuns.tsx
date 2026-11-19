// Finished evaluations kept on this computer (eval_output/gui_jobs), newest first.
import { useEffect, useState } from "react"
import { ChevronRight } from "lucide-react"

import { Page } from "@/components/app-chrome"
import { BtnLink, Note } from "@/components/form"
import { api, ApiError, type RecentRun } from "@/lib/api"
import { href } from "@/lib/router"
import { TASK_BY_KEY, TASKS, TEST_SET, type TaskKey } from "@/lib/tasks"
import { cn } from "@/lib/utils"

export function RecentRuns({ task }: { task: TaskKey | null }) {
  const [runs, setRuns] = useState<RecentRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .recentRuns()
      .then(setRuns)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
  }, [])

  const shown = runs?.filter((r) => !task || r.task === task) ?? []
  // Runs evaluated together (internal and external test set) open together.
  const entries: RecentRun[][] = []
  const byGroup = new Map<string, RecentRun[]>()
  for (const r of shown) {
    const together = r.group ? byGroup.get(r.group) : undefined
    if (together) together.push(r)
    else {
      const e = [r]
      entries.push(e)
      if (r.group) byGroup.set(r.group, e)
    }
  }
  for (const e of entries) e.sort((a, b) => (a.test_set === b.test_set ? 0 : a.test_set === "internal" ? -1 : 1))
  return (
    <Page>
      <div className="mb-8 flex flex-col gap-2">
        <h1 className="font-heading text-[clamp(2rem,4.5vw,3rem)] font-bold leading-tight tracking-[-0.02em]">Recent runs</h1>
        <p className="max-w-[64ch] text-[17px] text-foreground/80">
          Evaluations finished on this computer. Their files are in eval_output/gui_jobs.
        </p>
      </div>

      <nav aria-label="Filter by task" className="mb-6 flex flex-wrap gap-2">
        {[{ key: null, label: "All tasks" } as { key: TaskKey | null; label: string }, ...TASKS].map((t) => (
          <a
            key={t.key ?? "all"}
            href={href(t.key ? `/runs/${t.key}` : "/runs")}
            aria-current={task === t.key ? "page" : undefined}
            className={cn(
              "flex min-h-10 items-center rounded-full border px-4 text-sm font-medium transition-colors",
              task === t.key ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary/50",
            )}
          >
            {t.label}
          </a>
        ))}
      </nav>

      {error && <Note tone="error">{error}</Note>}
      {!runs && !error && <p className="text-muted-foreground">Loading…</p>}
      {runs && shown.length === 0 && (
        <div className="flex flex-col items-start gap-4 rounded-xl border bg-card px-6 py-8">
          <p className="text-[17px]">
            No finished {task ? TASK_BY_KEY[task].label.toLowerCase() : ""} evaluations on this computer yet.
          </p>
          <BtnLink variant="default" href={task ? href(`/task/${task}`) : href("/")}>
            Evaluate a CSV
          </BtnLink>
        </div>
      )}
      {entries.length > 0 && (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {entries.map((e) => {
            const first = e[0]
            return (
              <li key={first.run_id}>
                <a
                  href={href(`/results/${e.map((r) => r.run_id).join(",")}`)}
                  className="group flex items-center gap-4 px-5 py-4 outline-none hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:ring-inset"
                >
                  <span aria-hidden className="flex h-10 shrink-0 gap-1">
                    {e.map((r) => (
                      <span key={r.run_id} className="h-full w-1 rounded-full" style={{ background: TEST_SET[r.test_set].color }} />
                    ))}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-semibold [overflow-wrap:anywhere]">
                      {first.title || `${TASK_BY_KEY[first.task].label} results`}
                    </span>
                    <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                      {TASK_BY_KEY[first.task].label}
                      {first.mode ? ` (${first.mode === "fgr" ? "FGR" : "Standard"})` : ""}.{" "}
                      {e
                        .map(
                          (r) =>
                            `${TEST_SET[r.test_set].label}: ${r.csv}` +
                            (r.n_participants !== null ? `, ${r.n_participants} participants` : ""),
                        )
                        .join("; ")}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-sm text-muted-foreground sm:block">
                    {new Date(first.started).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                  </span>
                  <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </Page>
  )
}
