// The colour theme: follow the device, or always light, or always dark. The choice is kept in this
// browser only (localStorage); index.html applies it before the first paint so dark mode never flashes light.
import { useSyncExternalStore } from "react"

export type ThemeChoice = "system" | "light" | "dark"

const KEY = "figureus-theme"
const DARK_QUERY = "(prefers-color-scheme: dark)"
const listeners = new Set<() => void>()

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === "light" || v === "dark" || v === "system") return v
  } catch {
    // storage blocked (private window, site data off): follow the device
  }
  return "system"
}

let choice: ThemeChoice = stored()

/** Put the theme on <html>: the `dark` class switches every colour token; color-scheme switches native controls. */
export function applyTheme() {
  const dark = choice === "dark" || (choice === "system" && window.matchMedia(DARK_QUERY).matches)
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.style.colorScheme = dark ? "dark" : "light"
}

export function setTheme(next: ThemeChoice) {
  choice = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // not saved; it still applies until the page is closed
  }
  applyTheme()
  listeners.forEach((l) => l())
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => choice,
    () => "system",
  )
}

/** Follow the device while "Device" is chosen, and other open FigureUS(out) tabs when they change the theme. */
export function watchTheme() {
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (choice === "system") applyTheme()
  })
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return
    choice = stored()
    applyTheme()
    listeners.forEach((l) => l())
  })
  applyTheme()
}
