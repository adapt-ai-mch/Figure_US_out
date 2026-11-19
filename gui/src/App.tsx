// FigureUS(out): picks the screen from the address (#/task/regression, #/results/<run>, #/runs) and moves
// between screens like stacked cards (components/page-transition.tsx), with Lenis smoothing the scroll.
import { useEffect, useLayoutEffect, useState } from "react"
import { useLenis } from "lenis/react"

import { PageTransitions, type Direction } from "@/components/page-transition"
import { api } from "@/lib/api"
import { useRoute, type Route } from "@/lib/router"
import { RecentRuns } from "@/views/RecentRuns"
import { ResultsView } from "@/views/ResultsView"
import { StartPage } from "@/views/StartPage"
import { Workspace } from "@/views/Workspace"

// How deep a screen is: moving deeper slides the new screen up over the old one, moving shallower slides
// the old one away. Changing the Recent runs filter is not a new screen.
const DEPTH: Record<Route["name"], number> = { start: 0, runs: 1, task: 1, results: 2 }

function pageKey(route: Route): string {
  if (route.name === "task") return `task/${route.task}/${route.mode ?? ""}`
  if (route.name === "results") return `results/${route.runIds.join(",")}`
  return route.name
}

function Screen({ route }: { route: Route }) {
  if (route.name === "task") return <Workspace taskKey={route.task} mode={route.mode} />
  if (route.name === "results") return <ResultsView runIds={route.runIds} />
  if (route.name === "runs") return <RecentRuns task={route.task} />
  return <StartPage />
}

export default function App() {
  const route = useRoute()
  const key = pageKey(route)
  const depth = DEPTH[route.name]
  const [nav, setNav] = useState<{ key: string; depth: number; dir: Direction }>({ key, depth, dir: 1 })
  if (nav.key !== key) setNav({ key, depth, dir: depth >= nav.depth ? 1 : -1 })

  const lenis = useLenis()
  const [serverDown, setServerDown] = useState(false)

  useEffect(() => {
    api.health().then(
      () => setServerDown(false),
      () => setServerDown(true),
    )
  }, [key])

  // A new screen starts at the top. Before paint, so the incoming screen never shows at the old offset.
  useLayoutEffect(() => {
    lenis?.scrollTo(0, { immediate: true, force: true })
    window.scrollTo(0, 0)
  }, [key, lenis])

  return (
    <>
      {serverDown && (
        <div role="alert" className="bg-destructive px-4 py-3 text-center text-[15px] font-medium text-destructive-foreground">
          The FigureUS(out) server is not running, so nothing can be evaluated. In the skill folder run{" "}
          <code className="rounded bg-black/10 px-1.5 py-0.5 dark:bg-black/20">python server/app.py</code>, then reload this page.
        </div>
      )}
      <PageTransitions pageKey={nav.key} direction={nav.dir}>
        <Screen route={route} />
      </PageTransitions>
    </>
  )
}
