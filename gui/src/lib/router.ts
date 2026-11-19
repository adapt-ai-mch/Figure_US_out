// A tiny hash router: the browser's back button works and every screen has its own link.
import { useSyncExternalStore } from "react"

import { isTaskKey, type TaskKey } from "@/lib/tasks"

export type Route =
  | { name: "start" }
  | { name: "task"; task: TaskKey; mode: "standard" | "fgr" | null }
  | { name: "results"; runId: string }
  | { name: "runs"; task: TaskKey | null }

function parse(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#/, "").split("?")
  const parts = path.split("/").filter(Boolean)
  if (parts[0] === "task" && isTaskKey(parts[1])) {
    const mode = new URLSearchParams(query).get("mode")
    return { name: "task", task: parts[1], mode: mode === "standard" || mode === "fgr" ? mode : null }
  }
  if (parts[0] === "results" && parts[1]) return { name: "results", runId: parts[1] }
  if (parts[0] === "runs") return { name: "runs", task: isTaskKey(parts[1]) ? parts[1] : null }
  return { name: "start" }
}

let cached: { hash: string; route: Route } | null = null

function snapshot(): Route {
  const hash = window.location.hash
  if (!cached || cached.hash !== hash) cached = { hash, route: parse(hash) }
  return cached.route
}

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange)
  return () => window.removeEventListener("hashchange", onChange)
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, () => ({ name: "start" }) as Route)
}

export const href = (path: string) => `#${path}`

export function go(path: string) {
  window.location.hash = path
}
