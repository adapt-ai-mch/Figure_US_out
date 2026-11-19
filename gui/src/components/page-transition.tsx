// Moving between screens in the style of the stacked sticky sections in components/ui/smooth-scroll.tsx.
// Forward (start → task → results): the new screen slides up over the one you were on, rounded at the top,
// while that one stays exactly where it was and dims a little. Back: the screen you leave slides down and
// uncovers the one underneath. With "Reduce motion" on, screens simply change.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type Variants } from "framer-motion"

export type Direction = 1 | -1

// Where the page was scrolled to, so the screen being left can be held in place while it is covered.
// The app scrolls itself (every new screen starts at the top), so the browser must not restore an old
// position on Back first: that would move the page before the screen being left is pinned.
let lastScrollY = 0
window.addEventListener("scroll", () => (lastScrollY = window.scrollY), { passive: true })
if ("scrollRestoration" in history) history.scrollRestoration = "manual"

const DirectionContext = createContext<Direction>(1)

// The first screen after opening the app just appears. (Not AnimatePresence's initial={false}: that would
// also stop the start page's own intro, which plays inside this layer.)
let firstScreen = true

const EASE = [0.22, 1, 0.36, 1] as const
const DURATION = 0.75
const RADIUS = 24
const SHADOW_ON = "0px -18px 50px rgba(2, 6, 23, 0.28)"
const SHADOW_OFF = "0px -18px 50px rgba(2, 6, 23, 0)"
const COVERED = { scale: 0.96, filter: "brightness(0.78)" }

const variants: Variants = {
  // The incoming screen: from below the window (forward), or already in place under the leaving one (back).
  enter: (dir: Direction) =>
    dir > 0
      ? { y: "100vh", scale: 1, filter: "brightness(1)", borderTopLeftRadius: RADIUS, borderTopRightRadius: RADIUS, boxShadow: SHADOW_ON }
      : { y: 0, ...COVERED, borderTopLeftRadius: 0, borderTopRightRadius: 0, boxShadow: SHADOW_OFF },
  center: {
    y: 0,
    scale: 1,
    filter: "brightness(1)",
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    boxShadow: SHADOW_OFF,
    transitionEnd: { filter: "none", boxShadow: "none" },
  },
  // The outgoing screen: stays and dims while covered (forward), or slides away downwards (back).
  exit: (dir: Direction) =>
    dir > 0 ? COVERED : { y: "100vh", borderTopLeftRadius: RADIUS, borderTopRightRadius: RADIUS, boxShadow: SHADOW_ON },
}

function Layer({ children }: { children: ReactNode }) {
  const present = useIsPresent()
  const dir = useContext(DirectionContext)
  const reduced = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const [appearsAtOnce] = useState(() => firstScreen)
  useEffect(() => {
    firstScreen = false
  }, [])

  // A leaving screen is pinned to the window; scroll its copy to where the page was, so nothing jumps.
  useLayoutEffect(() => {
    if (!present && ref.current) ref.current.scrollTop = lastScrollY
  }, [present])

  // The moving screen is on top: the new one going forward, the old one going back.
  const onTop = present ? dir > 0 : dir < 0
  return (
    <motion.div
      ref={ref}
      custom={dir}
      variants={variants}
      initial={appearsAtOnce ? false : "enter"}
      animate="center"
      exit="exit"
      transition={reduced ? { duration: 0 } : { duration: DURATION, ease: EASE }}
      inert={!present}
      // overflow: clip rounds the top corners over the page's own header without breaking its sticky position.
      className={present ? "relative min-h-svh overflow-clip bg-background" : "fixed inset-0 overflow-hidden bg-background"}
      style={{ zIndex: onTop ? 2 : 1, transformOrigin: present ? "50% 0" : "50% 40%" }}
    >
      {children}
    </motion.div>
  )
}

/** Shows `children` as the screen `pageKey`; a new key brings the new screen in going `direction`. */
export function PageTransitions({ pageKey, direction, children }: { pageKey: string; direction: Direction; children: ReactNode }) {
  return (
    <DirectionContext.Provider value={direction}>
      <AnimatePresence custom={direction}>
        <Layer key={pageKey}>{children}</Layer>
      </AnimatePresence>
    </DirectionContext.Provider>
  )
}
