// FigureUS(out): picks the screen from the address (#/task/regression, #/results/<run>, #/runs).
import { useEffect, useState } from "react"

import { api } from "@/lib/api"
import { useRoute } from "@/lib/router"
import { RecentRuns } from "@/views/RecentRuns"
import { ResultsView } from "@/views/ResultsView"
import { StartPage } from "@/views/StartPage"
import { Workspace } from "@/views/Workspace"

export default function App() {
  const route = useRoute()
  const [serverDown, setServerDown] = useState(false)

  useEffect(() => {
    api.health().then(
      () => setServerDown(false),
      () => setServerDown(true),
    )
  }, [route])

  useEffect(() => {
    window.scrollTo({ top: 0 }) // newer browsers return a promise here; an effect must not return it
  }, [route])

  return (
    <>
      {serverDown && (
        <div role="alert" className="bg-destructive px-4 py-3 text-center text-[15px] font-medium text-destructive-foreground">
          The FigureUS(out) server is not running, so nothing can be evaluated. In the skill folder run{" "}
          <code className="rounded bg-black/10 px-1.5 py-0.5 dark:bg-black/20">python server/app.py</code>, then reload this page.
        </div>
      )}
      {route.name === "start" && <StartPage />}
      {route.name === "task" && (
        <Workspace key={`${route.task}-${route.mode}`} taskKey={route.task} mode={route.mode} />
      )}
      {route.name === "results" && <ResultsView key={route.runIds.join(",")} runIds={route.runIds} />}
      {route.name === "runs" && <RecentRuns task={route.task} />}
    </>
  )
}
