"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActivityFeed from "@/components/activity-feed";
import AppShell from "@/components/app-shell";
import {
  DownloadIcon,
  EmailIcon,
  FilterIcon,
  GlobeIcon,
  MapPinIcon,
  PhoneIcon,
  SearchIcon,
  SparkIcon,
} from "@/components/icons";
import { leadKeyForClient } from "@/lib/lead-key";
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

/** The scraper takes a single query string, but the UI collects keywords and location
 * separately. Joining with " in " matches the phrasing the scraper already expects
 * (e.g. "Dollar stores in London, Ontario"). */
function joinQuery(keywords: string, location: string): string {
  const cleanKeywords = keywords.trim().replace(/\s+/g, " ");
  const cleanLocation = location.trim().replace(/\s+/g, " ");
  if (!cleanLocation) return cleanKeywords;
  if (!cleanKeywords) return cleanLocation;
  return `${cleanKeywords} in ${cleanLocation}`;
}

/** Inverse of joinQuery, for restoring the two fields from a saved single-string query.
 * Splits on the last " in " so locations containing "in" survive the round trip. */
function splitQuery(query: string): { keywords: string; location: string } {
  const match = query.match(/^(.*)\s+in\s+(.+)$/i);
  if (!match) return { keywords: query, location: "" };
  return { keywords: match[1].trim(), location: match[2].trim() };
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

/** A prospect card in the results grid. Shows only fields the scraper actually
 * produces — there is no rating or category data behind a Lead. */
function LeadCard({
  lead,
  sendState,
  onOutreach,
}: {
  lead: Lead;
  sendState?: { channel: "call" | "email"; state: "sending" | "sent" | "error" };
  onOutreach: (channel: "call" | "email") => void;
}) {
  const initial = (lead.business_name || "?").charAt(0).toUpperCase();
  const hasContact = Boolean(lead.email || lead.phone);
  /** Name the channel that's actually reachable — a bare "Contactable" next to a
   * "No email" row reads like a bug. */
  const contactLabel = lead.email && lead.phone ? "Email + phone" : lead.email ? "Email" : lead.phone ? "Phone" : "No contact";

  function actionLabel(channel: "call" | "email", idle: string): string {
    if (sendState?.channel !== channel) return idle;
    if (sendState.state === "sending") return "Sending…";
    if (sendState.state === "sent") return channel === "call" ? "Called ✓" : "Sent ✓";
    return "Retry";
  }

  return (
    <article className="flex flex-col rounded-[20px] border border-line bg-white p-[22px] shadow-card transition-colors hover:border-[#dedaf9]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 flex-none place-items-center rounded-full bg-indigo-soft text-[14px] font-extrabold text-indigo">
            {initial}
          </span>
          <h3 className="m-0 truncate text-[16px] tracking-[-0.02em]">{lead.business_name || "Not found"}</h3>
        </div>
        <span
          className={`flex-none rounded-full px-2.5 py-1 text-[10px] font-bold ${
            hasContact ? "bg-green-soft text-green" : "bg-[#fef4e6] text-[#b26b0c]"
          }`}
        >
          {contactLabel}
        </span>
      </div>

      <dl className="mt-4 mb-5 flex flex-1 flex-col gap-2.5 text-[12px]">
        <div className="flex items-start gap-2.5 text-muted">
          <span className="mt-px flex-none text-[#a3a1b0]">
            <MapPinIcon />
          </span>
          <dd className="m-0 leading-[1.5]">
            {lead.address || lead.city || <span className="italic text-[#a3a1b0]">No address</span>}
          </dd>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="flex-none text-[#a3a1b0]">
            <GlobeIcon />
          </span>
          <dd className="m-0 min-w-0">
            {lead.website ? (
              <a
                href={lead.website}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-indigo no-underline hover:underline"
              >
                {lead.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
              </a>
            ) : (
              <span className="italic text-[#a3a1b0]">No website</span>
            )}
          </dd>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="flex-none text-[#a3a1b0]">
            <PhoneIcon />
          </span>
          <dd className="m-0 min-w-0">
            {lead.phone ? (
              <a href={`tel:${lead.phone}`} className="text-muted no-underline hover:text-indigo">
                {lead.phone}
              </a>
            ) : (
              <span className="italic text-[#a3a1b0]">No phone</span>
            )}
          </dd>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="flex-none text-[#a3a1b0]">
            <EmailIcon />
          </span>
          <dd className="m-0 min-w-0">
            {lead.email ? (
              <a href={`mailto:${lead.email}`} className="block truncate text-muted no-underline hover:text-indigo">
                {lead.email}
              </a>
            ) : (
              <span className="italic text-[#a3a1b0]">No email</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-auto flex gap-2" data-tour="card-actions">
        {(
          [
            { channel: "call" as const, icon: <PhoneIcon />, idle: "Call", enabled: Boolean(lead.phone) },
            { channel: "email" as const, icon: <EmailIcon />, idle: "Email", enabled: Boolean(lead.email) },
          ]
        ).map(({ channel, icon, idle, enabled }) => {
          const isThis = sendState?.channel === channel;
          return (
            <button
              key={channel}
              type="button"
              onClick={() => onOutreach(channel)}
              disabled={!enabled || sendState?.state === "sending"}
              title={
                enabled
                  ? channel === "call"
                    ? "Place a real AI phone call to this lead"
                    : "Send a real AI-drafted email to this lead"
                  : channel === "call"
                    ? "Needs a phone number"
                    : "Needs an email address"
              }
              className={`inline-flex h-[38px] flex-1 items-center justify-center gap-1.5 rounded-[11px] border text-[12px] font-bold transition-colors ${
                isThis && sendState.state === "sent"
                  ? "border-green/30 bg-green-soft text-green"
                  : isThis && sendState.state === "error"
                    ? "border-red/30 bg-red-soft text-red"
                    : "border-transparent bg-indigo-soft text-indigo hover:enabled:bg-[#e3e0ff]"
              }`}
            >
              {isThis && sendState.state === "sending" ? (
                <span className="size-3 animate-spin-fast rounded-full border-2 border-indigo/25 border-t-indigo" />
              ) : (
                icon
              )}
              {actionLabel(channel, idle)}
            </button>
          );
        })}
      </div>
    </article>
  );
}

type OutreachChannel = "call" | "email";
type LeadSendState = { channel: OutreachChannel; state: "sending" | "sent" | "error" };

export default function Dashboard() {
  const [keywords, setKeywords] = useState("");
  const [location, setLocation] = useState("");
  const [resultLimit, setResultLimit] = useState(5);
  const [leadSource, setLeadSource] = useState<"web" | "maps">("web");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [status, setStatus] = useState<JobStatus>(DEFAULT_STATUS);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState("");
  const [sendStates, setSendStates] = useState<Record<string, LeadSendState>>({});
  const initializedSearch = useRef(false);

  const query = joinQuery(keywords, location);

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
        const parts = splitQuery(payload.search.query);
        setKeywords(parts.keywords);
        setLocation(parts.location);
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

  async function sendToOutreach(lead: Lead, channel: OutreachChannel) {
    const leadKey = leadKeyForClient(lead);
    if (!leadKey) return;
    setActionError("");
    setSendStates((current) => ({ ...current, [leadKey]: { channel, state: "sending" } }));
    try {
      const response = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadKey, channel }),
      });
      const payload = (await response.json()) as { sent?: number; error?: string };
      if (!response.ok || !payload.sent) throw new Error(payload.error || "Could not send to outreach");
      setSendStates((current) => ({ ...current, [leadKey]: { channel, state: "sent" } }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not send to outreach");
      setSendStates((current) => ({ ...current, [leadKey]: { channel, state: "error" } }));
    }
  }

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
    <AppShell isActive={isActive}>
      <div className="mx-auto w-full max-w-[1240px] px-5 py-10 md:px-9 md:py-14">
        <section className="mx-auto mb-9 max-w-[720px] text-center">
          <h1 className="m-0 text-[clamp(34px,4vw,50px)] font-bold leading-[1.05] tracking-[-0.04em]">
            Lead Discovery
          </h1>
          <p className="mx-auto mt-4 max-w-[560px] text-[16px] leading-[1.65] text-muted">
            Find and qualify high-value prospects instantly. Search by keyword, industry, or location.
          </p>
        </section>

        <section className="mb-12 rounded-[20px] border border-line bg-white p-5 shadow-panel md:p-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <label
              className="flex h-[58px] flex-1 items-center gap-[11px] rounded-xl border border-[#d8d6e2] bg-white px-4 transition-shadow focus-within:border-indigo focus-within:shadow-[0_0_0_4px_rgba(91,79,233,0.09)]"
              data-tour="query"
            >
              <span className="flex-none text-[#a3a1b0]">
                <SearchIcon />
              </span>
              <input
                aria-label="Keywords"
                className="w-full border-0 bg-transparent text-[15px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-[#aaa8b6]"
                value={keywords}
                onChange={(event) => setKeywords(event.target.value)}
                placeholder="Keywords (e.g., Coffee shops)"
                autoComplete="off"
                disabled={isActive}
              />
            </label>
            <label
              className="flex h-[58px] flex-1 items-center gap-[11px] rounded-xl border border-[#d8d6e2] bg-white px-4 transition-shadow focus-within:border-indigo focus-within:shadow-[0_0_0_4px_rgba(91,79,233,0.09)]"
              data-tour="location"
            >
              <span className="flex-none text-[#a3a1b0]">
                <MapPinIcon />
              </span>
              <input
                aria-label="Location"
                className="w-full border-0 bg-transparent text-[15px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-[#aaa8b6]"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="Location (e.g., London)"
                autoComplete="off"
                disabled={isActive}
              />
            </label>
            <button
              type="button"
              onClick={runScrape}
              data-tour="run"
              disabled={isActive || loading || query.trim().length < 3}
              className="inline-flex h-[58px] flex-none items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-indigo bg-indigo px-8 text-[14px] font-bold text-white shadow-button transition-transform hover:enabled:-translate-y-px hover:enabled:bg-indigo-dark disabled:opacity-60"
            >
              {isActive ? (
                <span className="size-4 animate-spin-fast rounded-full border-2 border-white/35 border-t-white" />
              ) : (
                <SearchIcon />
              )}
              {isActive ? "Discovering…" : "Discover"}
            </button>
          </div>

          <div className="mt-5 flex flex-col gap-4 border-t border-[#e7e5ed] pt-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3" data-tour="source">
              <strong className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8a879a]">
                Data source:
              </strong>
              <div className="inline-flex gap-1.5 rounded-full bg-[#f3f2f8] p-1" role="group" aria-label="Lead source">
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
                    title={
                      option.value === "maps"
                        ? "Google Maps also returns businesses with no website"
                        : "Searches the open web and pulls contact details from each site"
                    }
                    className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12px] font-bold transition-colors disabled:opacity-60 ${
                      leadSource === option.value
                        ? "bg-white text-indigo shadow-card"
                        : "text-muted hover:enabled:text-ink"
                    }`}
                  >
                    {option.icon}
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2.5" data-tour="limit">
              <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8a879a]">Lead target:</span>
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
        </section>

        {actionError && (
          <div
            className="mb-6 flex gap-2.5 rounded-xl border border-[#ffd5dc] bg-[#fff5f6] px-4 py-3.5 text-[12px] text-[#9e3043]"
            role="alert"
          >
            <strong className="flex-none">Something needs attention</strong>
            <span>{actionError}</span>
          </div>
        )}

        <section className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-3" aria-label="Dashboard summary" data-tour="stats">
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

        <section className="mb-12" data-tour="results">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="m-0 text-[24px] font-bold tracking-[-0.03em]">
                {leads.length ? `Found ${leads.length} Prospect${leads.length === 1 ? "" : "s"}` : "Prospects"}
              </h2>
              <p className="m-0 mt-1 text-[13px] text-muted">
                {status.query
                  ? `Showing results for “${status.query}”`
                  : "Run a discovery search to populate this list"}
                {search.trim() && ` · ${visibleLeads.length} matching your filter`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <label className="flex h-[43px] min-w-[180px] flex-1 items-center gap-2 rounded-[11px] border border-[#dcdbe5] bg-white px-3 text-[#9996a5] focus-within:border-indigo focus-within:shadow-[0_0_0_3px_rgba(91,79,233,0.08)] sm:w-[220px] sm:flex-none">
                <FilterIcon />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter results…"
                  aria-label="Filter results"
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

          {visibleLeads.length > 0 && (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
              {visibleLeads.map((lead, index) => (
                <LeadCard
                  key={`${lead.website}-${lead.email}-${index}`}
                  lead={lead}
                  sendState={sendStates[leadKeyForClient(lead)]}
                  onOutreach={(channel) => void sendToOutreach(lead, channel)}
                />
              ))}
            </div>
          )}

          {!loading && !visibleLeads.length && (
            <div className="flex min-h-[280px] flex-col items-center justify-center rounded-[20px] border border-line bg-white p-9 text-center shadow-card">
              <span className="mb-3.5 grid size-12 place-items-center rounded-2xl bg-indigo-soft text-indigo">
                <SparkIcon />
              </span>
              <h3 className="m-0 mb-1.5 text-[15px]">
                {leads.length ? "No leads match your filter" : "Your prospects will appear here"}
              </h3>
              <p className="m-0 text-[12px] text-muted">
                {leads.length
                  ? "Try a broader search term."
                  : "Describe your target market above and run your first search."}
              </p>
            </div>
          )}
          {loading && (
            <div className="flex min-h-[280px] flex-col items-center justify-center rounded-[20px] border border-line bg-white p-9 text-center shadow-card">
              <span className="mb-3.5 size-4 animate-spin-fast rounded-full border-2 border-indigo/15 border-t-indigo" />
              <h3 className="m-0 mb-1.5 text-[15px]">Loading your workspace</h3>
            </div>
          )}
        </section>

        <section className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
          <article data-tour="progress" className="rounded-[20px] border border-line bg-white p-6 shadow-panel">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Live progress</h2>
                <p className="m-0 text-[12px] text-muted">Follow the current discovery run.</p>
              </div>
              <div
                className={`flex w-fit flex-none items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[9px] font-extrabold uppercase tracking-[0.12em] ${
                  STATUS_BADGE_STYLES[status.status] ?? STATUS_BADGE_STYLES.idle
                }`}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {status.status}
              </div>
            </div>
            <div className="mt-6 flex items-end justify-between">
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
            <div className="my-[11px] mb-6 h-[7px] overflow-hidden rounded-[9px] bg-[#eeedf3]">
              <span
                className="block h-full rounded-[inherit] bg-gradient-to-r from-indigo to-indigo-light transition-[width] duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 border-t border-line pt-[18px]">
              <small className="text-[10px] text-muted">
                {status.status === "discovering" ? "Searching for" : isActive ? "Currently processing" : "Latest activity"}
              </small>
              <strong className="truncate text-[12px]" title={status.currentUrl || status.query || status.message}>
                {status.currentUrl || status.query || status.message}
              </strong>
            </div>
            {status.error && <p className="mt-2.5 text-[11px] leading-[1.5] text-red">{status.error}</p>}
            <div className="mt-[19px] flex items-center gap-[7px] text-[10px] text-[#9492a0]">
              <span className={`size-1.5 rounded-full ${isActive ? "animate-glow bg-indigo" : "bg-[#b1afbb]"}`} />
              {status.updatedAt
                ? `Updated ${new Date(status.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                : "Waiting for the first run"}
            </div>
          </article>

          <aside className="rounded-[20px] border border-line bg-white p-6 shadow-panel" data-tour="activity">
            <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Live activity feed</h2>
            <p className="m-0 text-[12px] text-muted">Real-time workflow events.</p>
            <div className="mt-5 max-h-[420px] overflow-y-auto pr-1">
              <ActivityFeed events={activity} isActive={isActive} />
            </div>
          </aside>
        </section>
      </div>
    </AppShell>
  );
}
