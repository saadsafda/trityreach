"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActivityFeed from "@/components/activity-feed";
import { DownloadIcon, GlobeIcon, MapPinIcon, SearchIcon, SparkIcon } from "@/components/icons";
import TopNav from "@/components/top-nav";
import type { ActivityEvent, DashboardState, JobStatus, Lead, LeadField } from "@/lib/types";

const CSV_COLUMNS: { key: LeadField; label: string }[] = [
  { key: "business_name", label: "Business" },
  { key: "contact_name", label: "Contact" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "website", label: "Website" },
  { key: "city", label: "City" },
  { key: "address", label: "Address" },
];

const DEFAULT_STATUS: JobStatus = {
  jobId: "",
  status: "idle",
  currentUrl: "",
  completed: 0,
  total: 0,
  message: "Ready to scrape",
  error: "",
  query: "",
  discoveredUrls: [],
  updatedAt: "",
};

const STATUS_BADGE_STYLES: Record<string, string> = {
  running: "bg-indigo-soft text-indigo",
  queued: "bg-indigo-soft text-indigo",
  discovering: "bg-indigo-soft text-indigo",
  enriching: "bg-indigo-soft text-indigo",
  completed: "bg-green-soft text-green",
  failed: "bg-red-soft text-red",
  idle: "bg-[#f1f0f5] text-[#696777]",
};

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function StatCard({
  icon,
  iconClass,
  label,
  value,
  caption,
  captionClass,
}: {
  icon: React.ReactNode;
  iconClass: string;
  label: string;
  value: React.ReactNode;
  caption: string;
  captionClass: string;
}) {
  return (
    <article className="flex flex-col gap-4 rounded-[20px] border border-line bg-white p-5 px-[22px] shadow-card">
      <div className="flex items-start justify-between gap-3">
        <span className={`grid size-[46px] flex-none place-items-center rounded-2xl text-[19px] font-extrabold ${iconClass}`}>
          {icon}
        </span>
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${captionClass}`}>{caption}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        <strong className="truncate text-[28px] tracking-[-0.03em]">{value}</strong>
        <small className="text-[12px] text-muted">{label}</small>
      </div>
    </article>
  );
}

export default function Dashboard() {
  const [query, setQuery] = useState("");
  const [resultLimit, setResultLimit] = useState(5);
  const [leadSource, setLeadSource] = useState<"web" | "maps">("web");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [status, setStatus] = useState<JobStatus>(DEFAULT_STATUS);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState("");
  const initializedSearch = useRef(false);

  const fetchState = useCallback(async () => {
    try {
      const [stateResponse, activityResponse] = await Promise.all([
        fetch("/api/state", { cache: "no-store" }),
        fetch("/api/activity", { cache: "no-store" }),
      ]);
      const payload = (await stateResponse.json()) as DashboardState & { error?: string };
      if (!stateResponse.ok) throw new Error(payload.error || "Could not load dashboard state");
      setLeads(payload.leads);
      setStatus(payload.status);
      if (!initializedSearch.current) {
        setQuery(payload.search.query);
        setResultLimit(payload.search.limit);
        setLeadSource(payload.search.source ?? "web");
        initializedSearch.current = true;
      }
      if (activityResponse.ok) {
        const activityPayload = (await activityResponse.json()) as { events: ActivityEvent[] };
        setActivity(activityPayload.events);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not load dashboard state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void fetchState(), 0);
    const interval = window.setInterval(() => void fetchState(), 1200);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [fetchState]);

  const isActive =
    status.status === "queued" ||
    status.status === "discovering" ||
    status.status === "running" ||
    status.status === "enriching";
  const progress = status.total ? Math.round((status.completed / status.total) * 100) : 0;

  const contactedCount = useMemo(
    () => leads.filter((lead) => lead.email || lead.phone).length,
    [leads],
  );
  const pendingCount = leads.length - contactedCount;

  const visibleLeads = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return leads.filter((lead) => !needle || Object.values(lead).some((value) => value.toLowerCase().includes(needle)));
  }, [leads, search]);

  async function runScrape() {
    setActionError("");
    const normalizedQuery = query.trim().replace(/\s+/g, " ");
    if (normalizedQuery.length < 3) {
      setActionError("Describe the businesses and location you want to find.");
      return;
    }
    try {
      const response = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: normalizedQuery, limit: resultLimit, source: leadSource }),
      });
      const payload = (await response.json()) as { status?: JobStatus; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not start the scraper");
      if (payload.status) setStatus(payload.status);
      await fetchState();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not start the scraper");
    }
  }

  function exportCsv() {
    const rows = [
      CSV_COLUMNS.map((column) => csvCell(column.key)).join(","),
      ...visibleLeads.map((lead) => CSV_COLUMNS.map((column) => csvCell(lead[column.key])).join(",")),
    ];
    const blob = new Blob([`﻿${rows.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `trityreach-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="min-h-screen pb-16 md:pb-0">
      <TopNav isActive={isActive} />

      <div className="shell py-8 md:py-[70px] md:pb-8">
        <section className="mb-5 flex min-h-[220px] flex-col items-start gap-8 overflow-hidden px-2 pb-10 md:flex-row md:items-center md:justify-between md:gap-14">
          <div className="relative z-10 max-w-[640px]">
            <div className="mb-4 flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-[0.14em] text-indigo">
              <SparkIcon /> Workflow &amp; execution
            </div>
            <h1 className="m-0 text-[clamp(32px,4.4vw,58px)] font-bold leading-[0.99] tracking-[-0.05em]">
              Run the scraper.
              <br />
              <span className="text-indigo">Watch it work.</span>
            </h1>
            <p className="mt-5 max-w-[560px] text-[16px] leading-[1.7] text-muted">
              Trigger a discovery run, follow every step in real time, and see how many leads are found, enriched, and
              handed off for outreach.
            </p>
          </div>
        </section>

        <section className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3" aria-label="Dashboard summary">
          <StatCard
            icon={<SparkIcon />}
            iconClass="text-indigo bg-indigo-soft"
            label="Total leads scraped"
            value={leads.length}
            caption="Saved locally"
            captionClass="bg-indigo-soft text-indigo"
          />
          <StatCard
            icon={"✓"}
            iconClass="text-green bg-green-soft"
            label="Total contacted"
            value={contactedCount}
            caption="Has email or phone"
            captionClass="bg-green-soft text-green"
          />
          <StatCard
            icon={"…"}
            iconClass="text-blue bg-blue-soft"
            label="Pending"
            value={pendingCount}
            caption="Awaiting contact"
            captionClass="bg-blue-soft text-blue"
          />
        </section>

        {actionError && (
          <div className="mb-5 flex gap-2.5 rounded-xl border border-[#ffd5dc] bg-[#fff5f6] px-4 py-3.5 text-[12px] text-[#9e3043]" role="alert">
            <strong className="flex-none">Something needs attention</strong>
            <span>{actionError}</span>
          </div>
        )}

        <section className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.75fr)]">
          <article className="rounded-[20px] border border-line bg-white p-6 shadow-panel">
            <div className="flex items-center justify-between gap-5">
              <div className="flex items-center gap-3">
                <span className="grid size-[33px] flex-none place-items-center rounded-[10px] bg-indigo-soft text-[10px] font-extrabold tracking-[0.06em] text-indigo">
                  01
                </span>
                <div>
                  <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Describe the leads you want</h2>
                  <p className="m-0 text-[12px] text-muted">Use a business keyword and a specific location.</p>
                </div>
              </div>
            </div>
            <div className="my-[22px] mb-4 rounded-[15px] border border-[#dedde7] bg-[#fbfbfd] p-[18px]">
              <label className="flex min-h-[58px] items-center gap-[11px] rounded-xl border border-[#d8d6e2] bg-white px-4 transition-shadow focus-within:border-indigo focus-within:shadow-[0_0_0_4px_rgba(91,79,233,0.09)]">
                <SearchIcon />
                <input
                  aria-label="Lead search query"
                  className="w-full border-0 bg-transparent text-[15px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-[#aaa8b6]"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="e.g. Dollar stores in London, Ontario"
                  autoComplete="off"
                  disabled={isActive}
                />
              </label>
              <div className="mb-5 mt-[13px] flex flex-wrap items-center gap-[7px]" aria-label="Example searches">
                <span className="mr-0.5 text-[10px] font-bold text-[#92909d]">Try an example</span>
                {["Dollar stores in London, Ontario", "Independent dentists in Manchester, UK", "Real estate agencies in Dubai, UAE"].map(
                  (example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => setQuery(example)}
                      disabled={isActive}
                      className="rounded-lg border border-[#e2e0ea] bg-white px-2.5 py-1.5 text-[9px] text-[#625f70] hover:enabled:border-[#c8c3fb] hover:enabled:bg-indigo-soft hover:enabled:text-indigo"
                    >
                      {example}
                    </button>
                  ),
                )}
              </div>
              <div className="flex flex-col gap-3 border-t border-[#e7e5ed] pt-4">
                <div className="flex flex-col gap-[3px]">
                  <strong className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-[#8a879a]">Data source</strong>
                  <span className="text-[10px] text-muted">Where to find leads. Google Maps also returns businesses with no website.</span>
                </div>
                <div className="inline-flex flex-wrap gap-2 self-start" role="group" aria-label="Lead source">
                  {([
                    { value: "web", label: "Web Scraper", icon: <GlobeIcon /> },
                    { value: "maps", label: "Google Maps", icon: <MapPinIcon /> },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setLeadSource(option.value)}
                      disabled={isActive}
                      aria-pressed={leadSource === option.value}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.75 text-[11px] font-bold transition-colors disabled:opacity-60 ${
                        leadSource === option.value
                          ? "border-indigo bg-indigo text-white"
                          : "border-[#d8d6e2] bg-white text-[#625f70] hover:enabled:border-[#c8c3fb] hover:enabled:bg-indigo-soft hover:enabled:text-indigo"
                      }`}
                    >
                      {option.icon}
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-4 flex flex-col gap-3 border-t border-[#e7e5ed] pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
                <div className="flex flex-col gap-[3px]">
                  <strong className="text-[11px]">Lead target</strong>
                  <span className="text-[10px] text-muted">How many usable leads should be returned? Extra sources are checked when needed.</span>
                </div>
                <label>
                  <span className="visually-hidden">Maximum leads</span>
                  <select
                    value={resultLimit}
                    onChange={(event) => setResultLimit(Number(event.target.value))}
                    disabled={isActive}
                    className="h-[37px] min-w-[112px] rounded-[9px] border border-[#d8d6e2] bg-white px-2.5 text-[11px] font-bold text-[#464353] outline-none focus:border-indigo"
                  >
                    <option value={3}>3 leads</option>
                    <option value={5}>5 leads</option>
                    <option value={10}>10 leads</option>
                    <option value={15}>15 leads</option>
                    <option value={25}>25 leads</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-[18px]">
              <p className="m-0 text-[11px] leading-[1.5] text-muted">
                {leadSource === "maps"
                  ? <>Google Maps returns each business&apos;s name, phone, and address (including those with no website), then TrityReach enriches any that do have a site for email. Results persist in <code>leads.csv</code>.</>
                  : <>TrityReach keeps checking sources until the lead target is reached, then visits each official website and its contact/about pages for public email and phone details. Results persist in <code>leads.csv</code>.</>}
              </p>
              <button
                type="button"
                onClick={runScrape}
                disabled={isActive || loading || query.trim().length < 3}
                className="inline-flex h-[43px] flex-none items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border border-indigo bg-indigo px-[21px] text-[12px] font-bold text-white shadow-button transition-transform hover:enabled:-translate-y-px hover:enabled:bg-indigo-dark disabled:opacity-60 sm:w-auto"
              >
                {isActive ? <span className="size-4 animate-spin-fast rounded-full border-2 border-white/35 border-t-white" /> : <SparkIcon />}
                {isActive ? "Finding leads…" : "Run scrape"}
              </button>
            </div>
          </article>

          <aside className="relative overflow-hidden rounded-[20px] border border-line bg-white p-6 shadow-panel after:absolute after:-bottom-[90px] after:-right-20 after:size-[160px] after:rounded-full after:bg-indigo-soft after:opacity-55 after:content-['']">
            <div className="relative z-[1] flex items-center gap-3">
              <span className="grid size-[33px] flex-none place-items-center rounded-[10px] bg-indigo-soft text-[10px] font-extrabold tracking-[0.06em] text-indigo">
                02
              </span>
              <div>
                <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Live progress</h2>
                <p className="m-0 text-[12px] text-muted">Follow the current scrape.</p>
              </div>
            </div>
            <div
              className={`relative z-[1] my-6 flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[9px] font-extrabold uppercase tracking-[0.12em] ${
                STATUS_BADGE_STYLES[status.status] ?? STATUS_BADGE_STYLES.idle
              }`}
            >
              <span className="size-1.5 rounded-full bg-current" />
              {status.status}
            </div>
            <div className="relative z-[1] flex items-end justify-between">
              <div className="flex items-baseline gap-1.5">
                <strong className="text-2xl tracking-[-0.04em]">
                  {status.status === "discovering" ? status.discoveredUrls.length : status.completed}
                </strong>
                <span className="text-[11px] text-muted">
                  {status.status === "discovering" ? "websites found" : `of ${status.total || resultLimit} complete`}
                </span>
              </div>
              <strong className="text-[13px] text-indigo">{progress}%</strong>
            </div>
            <div className="relative z-[1] my-[11px] mb-6 h-[7px] overflow-hidden rounded-[9px] bg-[#eeedf3]">
              <span
                className="block h-full rounded-[inherit] bg-gradient-to-r from-indigo to-indigo-light transition-[width] duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="relative z-[1] flex min-w-0 flex-col gap-1.5 border-t border-line pt-[18px]">
              <small className="text-[10px] text-muted">
                {status.status === "discovering" ? "Searching for" : isActive ? "Currently processing" : "Latest activity"}
              </small>
              <strong className="truncate text-[12px]" title={status.currentUrl || status.query || status.message}>
                {status.currentUrl || status.query || status.message}
              </strong>
            </div>
            {status.error && <p className="relative z-[1] mt-2.5 text-[11px] leading-[1.5] text-red">{status.error}</p>}
            <div className="relative z-[1] mt-[19px] flex items-center gap-[7px] text-[10px] text-[#9492a0]">
              <span className={`size-1.5 rounded-full ${isActive ? "animate-glow bg-indigo" : "bg-[#b1afbb]"}`} />
              {status.updatedAt
                ? `Updated ${new Date(status.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                : "Waiting for the first run"}
            </div>
          </aside>
        </section>

        <section className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.75fr)]">
          <article className="overflow-hidden rounded-[20px] border border-line bg-white shadow-panel">
            <div className="flex flex-col gap-4 border-b border-line px-[26px] py-6 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
              <div className="flex items-center gap-3">
                <span className="grid size-[33px] flex-none place-items-center rounded-[10px] bg-indigo-soft text-[10px] font-extrabold tracking-[0.06em] text-indigo">
                  03
                </span>
                <div>
                  <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Lead results</h2>
                  <p className="m-0 text-[12px] text-muted">
                    {visibleLeads.length} of {leads.length} saved leads
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <label className="flex h-[43px] w-full items-center gap-2 rounded-[11px] border border-[#dcdbe5] px-3 text-[#9996a5] focus-within:border-indigo focus-within:shadow-[0_0_0_3px_rgba(91,79,233,0.08)] sm:w-[220px]">
                  <SearchIcon />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search leads…"
                    aria-label="Search leads"
                    className="w-full border-0 bg-transparent text-[12px] text-ink outline-none"
                  />
                </label>
                <button
                  type="button"
                  onClick={exportCsv}
                  disabled={!visibleLeads.length}
                  className="inline-flex h-[43px] flex-none items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border border-[#dcdbe5] bg-white px-4 text-[12px] font-bold text-[#3f3d4d] hover:enabled:border-indigo hover:enabled:text-indigo"
                >
                  <DownloadIcon /> Export CSV
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3 p-4">
              {visibleLeads.map((lead, index) => (
                <div
                  key={`${lead.website}-${lead.email}-${index}`}
                  className="flex flex-col gap-3 rounded-2xl border border-[#f0eff4] bg-[#fbfbfd] p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-10 flex-none place-items-center rounded-full bg-indigo-soft text-[13px] font-extrabold text-indigo">
                      {(lead.business_name || "?").charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <strong className="block truncate text-[13px] text-ink">{lead.business_name || "Not found"}</strong>
                      <span className="block truncate text-[11px] text-muted">
                        {lead.contact_name || "No contact name"}
                        {lead.city ? ` · ${lead.city}` : ""}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    {lead.email && (
                      <a
                        href={`mailto:${lead.email}`}
                        className="max-w-[220px] truncate rounded-full border border-[#dcdbe5] bg-white px-2.5 py-1 text-[11px] text-indigo hover:underline"
                      >
                        {lead.email}
                      </a>
                    )}
                    {lead.phone && (
                      <a
                        href={`tel:${lead.phone}`}
                        className="rounded-full border border-[#dcdbe5] bg-white px-2.5 py-1 text-[11px] text-indigo hover:underline"
                      >
                        {lead.phone}
                      </a>
                    )}
                    {lead.website ? (
                      <a
                        href={lead.website}
                        target="_blank"
                        rel="noreferrer"
                        className="max-w-[200px] truncate rounded-full border border-[#dcdbe5] bg-white px-2.5 py-1 text-[11px] text-indigo hover:underline"
                      >
                        {lead.website.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
                      </a>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#fef4e6] px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.06em] text-[#b26b0c] ring-1 ring-[#f6dcae]">
                        <span className="size-1.5 rounded-full bg-[#e08a1e]" />
                        No website
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {!loading && !visibleLeads.length && (
              <div className="flex min-h-[280px] flex-col items-center justify-center p-9 text-center">
                <span className="mb-3.5 grid size-12 place-items-center rounded-2xl bg-indigo-soft text-indigo">
                  <SparkIcon />
                </span>
                <h3 className="m-0 mb-1.5 text-[15px]">{leads.length ? "No leads match your search" : "Your leads will appear here"}</h3>
                <p className="m-0 text-[12px] text-muted">
                  {leads.length ? "Try a broader search term." : "Describe your target market above and run your first search."}
                </p>
              </div>
            )}
            {loading && (
              <div className="flex min-h-[280px] flex-col items-center justify-center p-9 text-center">
                <span className="mb-3.5 size-4 animate-spin-fast rounded-full border-2 border-indigo/15 border-t-indigo" />
                <h3 className="m-0 mb-1.5 text-[15px]">Loading your workspace</h3>
              </div>
            )}
          </article>

          <aside className="rounded-[20px] border border-line bg-white p-6 shadow-panel">
            <div className="mb-1 flex items-center gap-3">
              <span className="grid size-[33px] flex-none place-items-center rounded-[10px] bg-indigo-soft text-[10px] font-extrabold tracking-[0.06em] text-indigo">
                04
              </span>
              <div>
                <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Live activity feed</h2>
                <p className="m-0 text-[12px] text-muted">Real-time workflow events.</p>
              </div>
            </div>
            <div className="mt-5 max-h-[520px] overflow-y-auto pr-1">
              <ActivityFeed events={activity} isActive={isActive} />
            </div>
          </aside>
        </section>

        <footer className="flex flex-col items-start gap-1.5 px-[3px] pb-0.5 pt-6 text-[10px] text-[#9b99a5] sm:flex-row sm:items-center sm:justify-between sm:gap-0">
          <span className="font-extrabold uppercase tracking-[0.11em] text-[#706d80]">AI Trity Reach</span>
          <p className="m-0">Local-first lead intelligence · Your data stays in this workspace</p>
        </footer>
      </div>
    </main>
  );
}
