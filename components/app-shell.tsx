"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CompassIcon, UsersIcon } from "@/components/icons";
import TourGuide from "@/components/tour-guide";

const NAV_LINKS = [
  { href: "/", label: "Discovery", icon: CompassIcon, tour: "nav-workflow" },
  { href: "/leads", label: "CRM", icon: UsersIcon, tour: "nav-crm" },
] as const;

function NavItems({ variant }: { variant: "sidebar" | "mobile" }) {
  const pathname = usePathname();

  return (
    <>
      {NAV_LINKS.map((link) => {
        const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        const Icon = link.icon;

        if (variant === "mobile") {
          return (
            <Link
              key={link.href}
              href={link.href}
              data-tour={link.tour}
              className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl py-2 no-underline transition-colors ${
                active ? "bg-indigo-soft text-indigo" : "text-muted"
              }`}
            >
              <Icon />
              <span className="text-[10px] font-semibold">{link.label}</span>
            </Link>
          );
        }

        return (
          <Link
            key={link.href}
            href={link.href}
            data-tour={link.tour}
            className={`flex items-center gap-3 rounded-full px-4 py-3 text-[14px] font-semibold no-underline transition-colors ${
              active ? "bg-indigo-soft text-indigo" : "text-muted hover:bg-[#f3f2f8] hover:text-ink"
            }`}
          >
            <Icon />
            {link.label}
          </Link>
        );
      })}
    </>
  );
}

/** Sidebar + top strip chrome shared by every page. `isActive` drives the live
 * workspace dot, which pulses while a scrape is running.
 *
 * The sidebar is position:fixed, so the root below must NOT be a flex row — the
 * `md:ml-70` on the content column is what offsets it. Doing both double-counts
 * the sidebar width and pushes the page into horizontal overflow. */
export default function AppShell({ isActive, children }: { isActive: boolean; children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-70 flex-col border-r border-line bg-white px-6 py-7 md:flex">
        <Link href="/" className="flex items-center gap-3 no-underline" aria-label="AI Trity home">
          <span className="grid size-[42px] flex-none rotate-45 place-items-center rounded-xl bg-indigo shadow-[0_8px_18px_rgba(91,79,233,0.25)]">
            <span className="size-[14px] rounded-sm border-[3px] border-white border-l-transparent border-b-transparent" />
          </span>
          <span className="flex flex-col">
            <strong className="text-[19px] tracking-[-0.03em] text-indigo">AI Trity</strong>
            <small className="text-[11px] font-semibold text-muted">Reach Engine</small>
          </span>
        </Link>

        <nav className="mt-10 flex flex-col gap-1.5" aria-label="Primary" data-tour="nav">
          <NavItems variant="sidebar" />
        </nav>

        {/* Bottom-left is where the Next.js dev badge sits, so keep this to a single
            short row rather than wrapping text it would overlap. */}
        <div className="mt-auto border-t border-line pt-5 pb-1">
          <div
            className="flex items-center gap-2 text-[12px] text-muted"
            title="Local-first lead intelligence · your data stays in this workspace"
          >
            <span
              className={`size-2 flex-none rounded-full bg-green shadow-[0_0_0_4px_rgba(21,150,106,0.1)] ${
                isActive ? "animate-glow" : ""
              }`}
            />
            {isActive ? "Scrape running" : "Local workspace"}
          </div>
        </div>
      </aside>

      <div className="flex min-h-screen flex-col md:ml-70">
        <header className="sticky top-0 z-20 flex h-[76px] flex-none items-center justify-between gap-3 border-b border-line bg-white/92 px-5 backdrop-blur-md md:justify-end md:px-9">
          <Link href="/" className="flex items-center gap-2.5 no-underline md:hidden" aria-label="AI Trity home">
            <span className="grid size-[34px] flex-none rotate-45 place-items-center rounded-[10px] bg-indigo">
              <span className="size-[12px] rounded-sm border-[3px] border-white border-l-transparent border-b-transparent" />
            </span>
            <strong className="text-[16px] tracking-[-0.02em] text-indigo">AI Trity</strong>
          </Link>

          {/* The mockup's bell and avatar are omitted: there is no auth or notification
              system behind them, and non-functional chrome reads as broken UI. */}
          <div className="flex items-center gap-2.5">
            <TourGuide />
          </div>
        </header>

        <div className="flex-1 pb-20 md:pb-0">{children}</div>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex h-[68px] items-center gap-1.5 border-t border-line bg-white/95 px-2.5 backdrop-blur-md md:hidden"
        aria-label="Primary"
        data-tour="nav"
      >
        <NavItems variant="mobile" />
      </nav>
    </div>
  );
}
