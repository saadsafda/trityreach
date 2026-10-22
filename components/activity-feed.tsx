"use client";

import type { ActivityEvent, ActivityEventType } from "@/lib/types";

const TYPE_STYLES: Record<ActivityEventType, { dot: string; label: string }> = {
  discovering: { dot: "bg-blue", label: "Discovery" },
  scraping: { dot: "bg-indigo", label: "Scraping" },
  enriching: { dot: "bg-indigo", label: "Enriching" },
  lead_found: { dot: "bg-green", label: "Lead found" },
  webhook_sent: { dot: "bg-purple", label: "Webhook" },
  outreach_sent: { dot: "bg-purple", label: "Outreach" },
  erpnext: { dot: "bg-blue", label: "ERP" },
  completed: { dot: "bg-green", label: "Completed" },
  failed: { dot: "bg-red", label: "Failed" },
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

export default function ActivityFeed({ events, isActive }: { events: ActivityEvent[]; isActive: boolean }) {
  const ordered = [...events].reverse();

  return (
    <div className="flex flex-col">
      {ordered.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
          <p className="text-[13px] font-semibold text-ink">No activity yet</p>
          <p className="max-w-[220px] text-[12px] text-muted">
            Run a scrape to see live events here — discovery, scraping, enrichment, and outreach delivery.
          </p>
        </div>
      )}
      <ol className="relative flex flex-col gap-0">
        {ordered.map((event, index) => {
          const style = TYPE_STYLES[event.type] ?? TYPE_STYLES.scraping;
          const isFirst = index === 0;
          const isLast = index === ordered.length - 1;
          return (
            <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
              {!isLast && <span className="absolute left-[5px] top-3 h-full w-px bg-line" aria-hidden="true" />}
              <span
                className={`relative z-10 mt-1.5 size-[11px] flex-none rounded-full ${style.dot} ${
                  isFirst && isActive ? "animate-glow" : ""
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted">{style.label}</span>
                  <span className="flex-none text-[10px] text-muted/70">{formatTime(event.createdAt)}</span>
                </div>
                <p className="mt-0.5 truncate text-[13px] font-medium text-ink" title={event.message}>
                  {event.message}
                </p>
                {event.detail && (
                  <p className="mt-0.5 truncate text-[11px] text-muted" title={event.detail}>
                    {event.detail}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
