"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GridIcon, UsersIcon } from "@/components/icons";

const NAV_LINKS = [
  { href: "/", label: "Workflow", icon: GridIcon },
  { href: "/leads", label: "CRM", icon: UsersIcon },
] as const;

export default function TopNav({ isActive }: { isActive: boolean }) {
  const pathname = usePathname();

  return (
    <>
      <header className="sticky top-0 z-20 h-[76px] border-b border-line bg-white/92 backdrop-blur-md">
        <div className="shell flex h-full items-center justify-between gap-3">
          <div className="flex items-center gap-9">
            <Link href="/" className="flex items-center gap-[11px] no-underline" aria-label="AI Trity home">
              <span className="grid size-[38px] rotate-45 place-items-center rounded-xl bg-indigo shadow-[0_8px_18px_rgba(91,79,233,0.25)]">
                <span className="size-[13px] rounded-sm border-[3px] border-white border-l-transparent border-b-transparent" />
              </span>
              <span className="flex items-baseline gap-[7px]">
                <strong className="text-[17px] tracking-[-0.02em] text-ink">AI Trity</strong>
                <small className="text-[9px] font-extrabold tracking-[0.19em] text-indigo">REACH</small>
              </span>
            </Link>
            <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
              {NAV_LINKS.map((link) => {
                const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`rounded-lg px-3.5 py-2 text-[13px] font-semibold no-underline transition-colors ${
                      active ? "bg-indigo-soft text-indigo" : "text-muted hover:text-ink"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <span
              className={`size-2 rounded-full bg-green shadow-[0_0_0_4px_rgba(21,150,106,0.1)] ${
                isActive ? "animate-glow" : ""
              }`}
            />
            <span className="hidden sm:inline">Local workspace</span>
          </div>
        </div>
      </header>

      <nav
        className="fixed inset-x-0 bottom-0 z-20 flex h-[68px] items-center gap-1.5 border-t border-line bg-white/95 px-2.5 backdrop-blur-md md:hidden"
        aria-label="Primary"
      >
        {NAV_LINKS.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl py-2 no-underline transition-colors ${
                active ? "bg-indigo-soft text-indigo" : "text-muted"
              }`}
            >
              <Icon />
              <span className="text-[10px] font-semibold">{link.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
