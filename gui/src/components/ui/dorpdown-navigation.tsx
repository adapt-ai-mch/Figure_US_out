/*
 * Adapted from the supplied 21st.dev "dorpdown-navigation" component for FigureUS(out).
 * The file name is kept so "@/components/ui/dorpdown-navigation" imports still work.
 *
 * What changed, and why:
 * 1. Props are typed as { navItems: NavItem[] }. The original read `navItems` from the
 *    item type, which does not compile.
 * 2. The root is a <nav> that takes className and aria-label, not a full-screen
 *    <main className="min-h-screen">: a page may have only one <main>, and this menu
 *    sits inside the hero.
 * 3. Menus still open on hover. A click (or Enter / Space) now pins one open and a
 *    second click closes it; Escape or a click outside also closes it. Triggers carry
 *    aria-expanded, aria-haspopup and aria-controls.
 * 4. Optional props (without them it behaves like the original):
 *    renderTrigger – supply your own trigger, e.g. a LiquidButton;
 *    onSelect      – sub-menu items become buttons that call it (otherwise links to item.href or "#");
 *    side          – "top" opens the menu upward; align – "center" centres it on its trigger;
 *    listClassName – classes for the top-level <ul>.
 * 5. Menu columns stack on phone-width screens, the menu is capped at the screen width,
 *    and an open menu is nudged sideways to stay inside the nearest container that clips
 *    overflow, so it is never cut off.
 * 6. Sub-item contents are block-styled <span>s instead of <div>/<p>, so they are valid
 *    inside a <button> as well as an <a>. They look the same. Each item also carries an
 *    aria-label ("label: description") so screen readers announce both lines.
 *
 * The look and the framer-motion animations (shared "hover-bg" and "menu" layout ids,
 * chevron rotation) are unchanged.
 */
import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export type NavSubItem = {
  label: string;
  description: string;
  icon: React.ElementType;
  /** Link target when no onSelect handler is given. */
  href?: string;
};

export type NavItem = {
  id: number;
  label: string;
  subMenus?: {
    title: string;
    items: NavSubItem[];
  }[];
  link?: string;
};

export type DropdownTriggerState = {
  open: boolean;
  toggle: () => void;
  menuId: string;
};

type DropdownNavigationProps = {
  navItems: NavItem[];
  renderTrigger?: (item: NavItem, state: DropdownTriggerState) => React.ReactNode;
  onSelect?: (navItem: NavItem, item: NavSubItem) => void;
  side?: "bottom" | "top";
  align?: "start" | "center";
  className?: string;
  listClassName?: string;
  "aria-label"?: string;
};

export function DropdownNavigation({
  navItems,
  renderTrigger,
  onSelect,
  side = "bottom",
  align = "start",
  className,
  listClassName,
  "aria-label": ariaLabel,
}: DropdownNavigationProps) {
  const [openMenu, setOpenMenu] = React.useState<string | null>(null);
  const [pinned, setPinned] = React.useState(false);
  const [isHover, setIsHover] = React.useState<number | null>(null);
  const rootRef = React.useRef<HTMLElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const baseId = React.useId();

  // Keep an open menu inside the nearest container that clips overflow (here the hero):
  // measure it after layout and nudge it sideways if it would spill past either edge.
  React.useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !openMenu) return;
    menu.style.marginLeft = "0px";
    let bound: Element | null = rootRef.current?.parentElement ?? null;
    while (bound && getComputedStyle(bound).overflowX === "visible") bound = bound.parentElement;
    const limit = (bound ?? document.documentElement).getBoundingClientRect();
    const gap = 12;
    const rect = menu.getBoundingClientRect();
    let dx = 0;
    if (rect.right > limit.right - gap) dx = limit.right - gap - rect.right;
    if (rect.left + dx < limit.left + gap) dx = limit.left + gap - rect.left;
    menu.style.marginLeft = `${dx}px`;
  }, [openMenu]);

  const handleHover = (menuLabel: string | null) => {
    if (!pinned) setOpenMenu(menuLabel);
  };

  const close = React.useCallback(() => {
    setOpenMenu(null);
    setPinned(false);
  }, []);

  const toggle = (menuLabel: string) => {
    if (pinned && openMenu === menuLabel) {
      close();
    } else {
      setOpenMenu(menuLabel);
      setPinned(true);
    }
  };

  React.useEffect(() => {
    if (!openMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [openMenu, close]);

  return (
    <nav ref={rootRef} aria-label={ariaLabel} className={cn("relative", className)}>
      <ul className={cn("relative flex items-center space-x-0", listClassName)}>
        {navItems.map((navItem) => {
          const open = openMenu === navItem.label;
          const menuId = `${baseId}-menu-${navItem.id}`;
          return (
            <li
              key={navItem.label}
              className="relative"
              onMouseEnter={() => handleHover(navItem.label)}
              onMouseLeave={() => handleHover(null)}
            >
              {renderTrigger ? (
                renderTrigger(navItem, { open, toggle: () => toggle(navItem.label), menuId })
              ) : (
                <button
                  type="button"
                  aria-expanded={navItem.subMenus ? open : undefined}
                  aria-haspopup={navItem.subMenus ? "true" : undefined}
                  aria-controls={navItem.subMenus && open ? menuId : undefined}
                  onClick={() => navItem.subMenus && toggle(navItem.label)}
                  className="text-sm py-1.5 px-4 flex cursor-pointer group transition-colors duration-300 items-center justify-center gap-1 text-muted-foreground hover:text-foreground relative"
                  onMouseEnter={() => setIsHover(navItem.id)}
                  onMouseLeave={() => setIsHover(null)}
                >
                  <span>{navItem.label}</span>
                  {navItem.subMenus && (
                    <ChevronDown
                      className={`h-4 w-4 group-hover:rotate-180 duration-300 transition-transform
                        ${open ? "rotate-180" : ""}`}
                    />
                  )}
                  {(isHover === navItem.id || open) && (
                    <motion.div
                      layoutId="hover-bg"
                      className="absolute inset-0 size-full bg-primary/10"
                      style={{ borderRadius: 99 }}
                    />
                  )}
                </button>
              )}

              <AnimatePresence>
                {open && navItem.subMenus && (
                  <div
                    id={menuId}
                    ref={menuRef}
                    className={cn(
                      "absolute z-50 w-max",
                      side === "top" ? "bottom-full pb-2" : "top-full pt-2",
                      align === "center" ? "left-1/2 -translate-x-1/2" : "left-0",
                    )}
                  >
                    <motion.div
                      className="bg-background border border-border p-4 w-max max-w-[calc(100vw-3rem)]"
                      style={{ borderRadius: 16 }}
                      layoutId="menu"
                    >
                      <div className="w-fit shrink-0 flex flex-col gap-6 overflow-hidden sm:flex-row sm:gap-9">
                        {navItem.subMenus.map((sub) => (
                          <motion.div layout className="w-full" key={sub.title}>
                            <h3 className="mb-4 text-sm font-medium capitalize text-muted-foreground">
                              {sub.title}
                            </h3>
                            <ul className="space-y-6">
                              {sub.items.map((item) => {
                                const Icon = item.icon;
                                // Spans (styled as blocks) so the same body is valid inside a <button> or an <a>.
                                const body = (
                                  <>
                                    <span className="border border-border text-foreground rounded-md flex items-center justify-center size-9 shrink-0 group-hover:bg-accent group-hover:text-accent-foreground transition-colors duration-300">
                                      <Icon aria-hidden className="h-5 w-5 flex-none" />
                                    </span>
                                    <span className="block leading-5 sm:w-max">
                                      <span className="block text-sm font-medium text-foreground shrink-0">
                                        {item.label}
                                      </span>
                                      <span className="block text-xs text-muted-foreground shrink-0 group-hover:text-foreground transition-colors duration-300">
                                        {item.description}
                                      </span>
                                    </span>
                                  </>
                                );
                                return (
                                  <li key={item.label}>
                                    {onSelect ? (
                                      <button
                                        type="button"
                                        aria-label={`${item.label}: ${item.description}`}
                                        onClick={() => {
                                          onSelect(navItem, item);
                                          close();
                                        }}
                                        className="flex items-start space-x-3 group cursor-pointer text-left"
                                      >
                                        {body}
                                      </button>
                                    ) : (
                                      <a
                                        href={item.href ?? "#"}
                                        aria-label={`${item.label}: ${item.description}`}
                                        className="flex items-start space-x-3 group"
                                      >
                                        {body}
                                      </a>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </motion.div>
                        ))}
                      </div>
                    </motion.div>
                  </div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
