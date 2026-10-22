"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActivityFeed from "@/components/activity-feed";
import AppShell from "@/components/app-shell";
import {
  BuildingIcon,
  DownloadIcon,
  EmailIcon,
  FilterIcon,
  GlobeIcon,
  MapPinIcon,
  PhoneIcon,
  SearchIcon,
  SparkIcon,
  UploadIcon,
} from "@/components/icons";
import { leadKeyForClient } from "@/lib/lead-key";
import Link from "next/link";
import SendToErpButton from "@/components/send-to-erp-button";
import StoreTypesModal from "@/components/store-types-modal";
import UploadLeadsModal from "@/components/upload-leads-modal";
import type { SearchMemorySummary } from "@/lib/store-search-memory";
import { DEFAULT_STORE_TYPES, PLACES_COST_PER_REQUEST, storeSearchPlan } from "@/lib/store-types";
import { useStoreCatalog } from "@/lib/use-store-catalog";
import type { ActivityEvent, DashboardState, ErpNextStatus, JobStatus, Lead, LeadField, LeadSource } from "@/lib/types";

const CSV_COLUMNS: { key: LeadField; label: string }[] = [
  { key: "business_name", label: "Business" },
  { key: "contact_name", label: "Contact" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "website", label: "Website" },
  { key: "city", label: "City" },
  { key: "address", label: "Address" },
  { key: "store_type", label: "Store type" },
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
  erpConnected,
}: {
  lead: Lead;
  sendState?: { channel: "call" | "email"; state: "sending" | "sent" | "error" };
  onOutreach: (channel: "call" | "email") => void;
  erpConnected: boolean;
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
          <div className="min-w-0">
            <h3 className="m-0 truncate text-[16px] tracking-[-0.02em]">{lead.business_name || "Not found"}</h3>
            {lead.store_type && <span className="block truncate text-[11px] font-semibold text-indigo">{lead.store_type}</span>}
          </div>
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
        {erpConnected && <SendToErpButton lead={lead} />}
      </div>
    </article>
  );
}

/** Most cities one Store Finder run may search (also enforced by /api/scrape). */
const MAX_LOCATIONS = 20;

type OutreachChannel = "call" | "email";
type LeadSendState = { channel: OutreachChannel; state: "sending" | "sent" | "error" };

export default function Dashboard() {
  const [keywords, setKeywords] = useState("");
  const [location, setLocation] = useState("");
  const [resultLimit, setResultLimit] = useState(25);
  const [leadSource, setLeadSource] = useState<LeadSource>("stores");
  const [storeTypes, setStoreTypes] = useState<string[]>([...DEFAULT_STORE_TYPES]);
  const [locations, setLocations] = useState<string[]>([]);
  const [locationDraft, setLocationDraft] = useState("");
  const [autoOutreach, setAutoOutreach] = useState(false);
  const locationInputRef = useRef<HTMLInputElement>(null);
  const { types: storeCatalog, setTypes: setStoreCatalog } = useStoreCatalog();
  const [showStoreTypes, setShowStoreTypes] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  /** "08817" → "Edison, NJ", for ZIP chips. */
  const [zipLabels, setZipLabels] = useState<Record<string, string>>({});
  const [zipRadius, setZipRadius] = useState(5);
  const [checkingZip, setCheckingZip] = useState(false);
  /** What earlier Store Finder runs covered in the chosen locations. */
  const [searchMemory, setSearchMemory] = useState<(SearchMemorySummary & { key: string }) | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [status, setStatus] = useState<JobStatus>(DEFAULT_STATUS);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState("");
  const [sendStates, setSendStates] = useState<Record<string, LeadSendState>>({});
  const [erpnext, setErpnext] = useState<ErpNextStatus | null>(null);
  const initializedSearch = useRef(false);

  const query = joinQuery(keywords, location);
  /** Locations including one typed but not yet added with Enter. */
  const pendingLocations = useMemo(() => {
    const draft = locationDraft.trim().replace(/\s+/g, " ");
    return draft && !locations.includes(draft) ? [...locations, draft] : locations;
  }, [locations, locationDraft]);
  /** Store types still in the picker (removed ones drop out of the selection). */
  const pickableTypes = useMemo(() => storeCatalog.filter((type) => !type.hidden), [storeCatalog]);
  const selectedTypes = useMemo(
    () => pickableTypes.filter((type) => storeTypes.includes(type.key)),
    [pickableTypes, storeTypes],
  );
  const plan = storeSearchPlan(selectedTypes, pendingLocations.length, resultLimit);
  const canRun =
    leadSource === "stores" ? selectedTypes.length > 0 && pendingLocations.length > 0 : query.trim().length >= 3;

  /** Look a ZIP up (cached server-side) so its chip can name the town. */
  const lookupZip = useCallback(async (zip: string): Promise<string | null> => {
    const response = await fetch(`/api/zip?zip=${zip}`, { cache: "no-store" });
    const payload = (await response.json()) as { label?: string; error?: string };
    if (!response.ok) throw new Error(payload.error || `ZIP code ${zip} wasn't found.`);
    const label = payload.label || "";
    setZipLabels((current) => ({ ...current, [zip]: label }));
    return label;
  }, []);

  function addLocation(value: string) {
    const place = value.trim().replace(/\s+/g, " ").replace(/;$/, "");
    setLocationDraft("");
    if (place.length < 2 || locations.includes(place) || locations.length >= MAX_LOCATIONS) return;
    if (!/^\d{5}$/.test(place)) {
      if (/^\d{3,9}(-\d{4})?$/.test(place)) {
        setActionError("Enter a 5-digit ZIP code, e.g. 08817.");
        return;
      }
      setLocations((current) => [...current, place]);
      return;
    }
    // A ZIP: confirm it exists before adding the chip.
    setCheckingZip(true);
    setActionError("");
    void lookupZip(place)
      .then(() => setLocations((current) => (current.includes(place) ? current : [...current, place])))
      .catch((error: unknown) => setActionError(error instanceof Error ? error.message : "Could not check that ZIP code"))
      .finally(() => setCheckingZip(false));
  }

  const hasZip = pendingLocations.some((place) => /^\d{5}$/.test(place));

  function changeSource(next: LeadSource) {
    setLeadSource(next);
    // Store runs go up to 100; web/maps runs stay at 25 or fewer.
    setResultLimit((current) => (next === "stores" ? Math.max(10, current) : Math.min(25, current)));
  }

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
      setErpnext(payload.erpnext);
      if (!initializedSearch.current) {
        const parts = splitQuery(payload.search.query);
        setKeywords(parts.keywords);
        setLocation(parts.location);
        setResultLimit(payload.search.limit);
        setLeadSource(payload.search.source ?? "stores");
        setStoreTypes(payload.search.storeTypes?.length ? payload.search.storeTypes : [...DEFAULT_STORE_TYPES]);
        setLocations(payload.search.locations ?? []);
        setZipRadius(typeof payload.search.zipRadius === "number" ? payload.search.zipRadius : 5);
        for (const place of payload.search.locations ?? []) {
          if (/^\d{5}$/.test(place)) void lookupZip(place).catch(() => undefined);
        }
        setAutoOutreach(payload.search.autoOutreach === true);
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
  }, [lookupZip]);

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

  const memoryKey = pendingLocations.join("|");
  const memoryHint = leadSource === "stores" && searchMemory?.key === memoryKey ? searchMemory : null;
  // Re-read after each run too (isActive flips back), so the count stays current.
  useEffect(() => {
    if (leadSource !== "stores" || isActive || !memoryKey) return;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/store-search?locations=${encodeURIComponent(memoryKey)}`, { cache: "no-store" });
        if (response.ok) setSearchMemory({ key: memoryKey, ...((await response.json()) as SearchMemorySummary) });
      } catch {
        // Only a hint; the run itself still continues where it left off.
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [leadSource, isActive, memoryKey]);

  async function startSearchesOver() {
    if (
      !window.confirm(
        "Start these searches over? The next run searches Google Maps from the top again and can return stores earlier runs already found (ones already in ERP are still skipped).",
      )
    ) {
      return;
    }
    setActionError("");
    try {
      const response = await fetch("/api/store-search", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locations: pendingLocations }),
      });
      const payload = (await response.json()) as SearchMemorySummary & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not start the searches over");
      setSearchMemory({ key: memoryKey, found: payload.found, searches: payload.searches, usedUp: payload.usedUp });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not start the searches over");
    }
  }

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
    if (leadSource !== "stores" && normalizedQuery.length < 3) {
      setActionError("Describe the businesses and location you want to find.");
      return;
    }
    if (leadSource === "stores" && (!selectedTypes.length || !pendingLocations.length)) {
      setActionError("Pick at least one store type and add a city.");
      return;
    }
    if (
      leadSource === "stores" &&
      plan.budget * PLACES_COST_PER_REQUEST >= 3 &&
      !window.confirm(
        `This run can use up to ${plan.budget} Google Maps requests (≈ $${(plan.budget * PLACES_COST_PER_REQUEST).toFixed(2)}) and may take a while. Start it?`,
      )
    ) {
      return;
    }
    if (autoOutreach && !window.confirm("Auto-call is on: every new lead with a phone number will get a real AI call when the run finishes. Continue?")) {
      return;
    }
    if (pendingLocations.length !== locations.length) setLocations(pendingLocations);
    setLocationDraft("");
    try {
      const response = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: normalizedQuery,
          limit: resultLimit,
          source: leadSource,
          storeTypes: selectedTypes.map((type) => type.key),
          locations: pendingLocations,
          zipRadius,
          autoOutreach,
        }),
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
            Find independent supermarkets, dollar stores and other retailers to sell to — or search any business by keyword.
          </p>
        </section>

        <section className="mb-12 rounded-[20px] border border-line bg-white p-5 shadow-panel md:p-6">
          {leadSource === "stores" ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
                <div
                  className="flex min-h-[58px] flex-1 flex-wrap items-center gap-2 rounded-xl border border-[#d8d6e2] bg-white px-4 py-2.5 transition-shadow focus-within:border-indigo focus-within:shadow-[0_0_0_4px_rgba(91,79,233,0.09)]"
                  data-tour="location"
                  onClick={() => locationInputRef.current?.focus()}
                >
                  <span className="flex-none text-[#a3a1b0]">
                    <MapPinIcon />
                  </span>
                  {locations.map((place) => (
                    <span
                      key={place}
                      className="inline-flex items-center gap-1 rounded-full bg-indigo-soft py-1 pr-1.5 pl-3 text-[12px] font-bold text-indigo"
                    >
                      {/^\d{5}$/.test(place) ? (
                        <>
                          ZIP {place}
                          {zipLabels[place] && <span className="font-semibold opacity-75">· {zipLabels[place]}</span>}
                        </>
                      ) : (
                        place
                      )}
                      <button
                        type="button"
                        aria-label={`Remove ${place}`}
                        disabled={isActive}
                        onClick={(event) => {
                          event.stopPropagation();
                          setLocations((current) => current.filter((item) => item !== place));
                        }}
                        className="grid size-5 place-items-center rounded-full hover:bg-white/70"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    ref={locationInputRef}
                    aria-label="Add a location"
                    className="min-w-[180px] flex-1 border-0 bg-transparent text-[15px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-[#aaa8b6]"
                    value={locationDraft}
                    onChange={(event) => setLocationDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === ";") {
                        event.preventDefault();
                        addLocation(locationDraft);
                      } else if (event.key === "Backspace" && !locationDraft && locations.length) {
                        setLocations((current) => current.slice(0, -1));
                      }
                    }}
                    onBlur={() => addLocation(locationDraft)}
                    placeholder={
                      checkingZip
                        ? "Checking ZIP code…"
                        : locations.length
                          ? "Add another city or ZIP…"
                          : "City or ZIP code, e.g. Edison, NJ or 08817 — press Enter to add"
                    }
                    autoComplete="off"
                    disabled={isActive || locations.length >= MAX_LOCATIONS}
                  />
                </div>
                <button
                  type="button"
                  onClick={runScrape}
                  data-tour="run"
                  disabled={isActive || loading || !canRun}
                  className="inline-flex h-[58px] flex-none items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-indigo bg-indigo px-8 text-[14px] font-bold text-white shadow-button transition-transform hover:enabled:-translate-y-px hover:enabled:bg-indigo-dark disabled:opacity-60"
                >
                  {isActive ? (
                    <span className="size-4 animate-spin-fast rounded-full border-2 border-white/35 border-t-white" />
                  ) : (
                    <SearchIcon />
                  )}
                  {isActive ? "Finding stores…" : "Find stores"}
                </button>
              </div>

              <div data-tour="query">
                <strong className="mb-2 block text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8a879a]">
                  Store types
                </strong>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Store types">
                  {pickableTypes.map((type) => {
                    const selected = storeTypes.includes(type.key);
                    return (
                      <button
                        key={type.key}
                        type="button"
                        title={type.hint}
                        aria-pressed={selected}
                        disabled={isActive}
                        onClick={() =>
                          setStoreTypes((current) =>
                            selected ? current.filter((key) => key !== type.key) : [...current, type.key],
                          )
                        }
                        className={`rounded-full border px-3.5 py-2 text-[12px] font-bold transition-colors disabled:opacity-60 ${
                          selected
                            ? "border-indigo bg-indigo text-white"
                            : "border-[#dcdbe5] bg-white text-[#3f3d4d] hover:enabled:border-indigo hover:enabled:text-indigo"
                        }`}
                      >
                        {selected ? "✓ " : ""}
                        {type.label}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setShowStoreTypes(true)}
                    disabled={isActive}
                    className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[#c9c6d8] bg-white px-3.5 py-2 text-[12px] font-bold text-muted hover:enabled:border-indigo hover:enabled:text-indigo disabled:opacity-60"
                  >
                    + Add / remove types
                  </button>
                </div>
              </div>
            </div>
          ) : (
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
                disabled={isActive || loading || !canRun}
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
          )}

          <div className="mt-5 flex flex-col gap-4 border-t border-[#e7e5ed] pt-5 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-3" data-tour="source">
              <strong className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8a879a]">
                Data source:
              </strong>
              <div className="inline-flex flex-wrap gap-1.5 rounded-full bg-[#f3f2f8] p-1" role="group" aria-label="Lead source">
                {([
                  { value: "stores", label: "Store Finder", icon: <BuildingIcon /> },
                  { value: "maps", label: "Google Maps", icon: <MapPinIcon /> },
                  { value: "web", label: "Web Scraper", icon: <GlobeIcon /> },
                ] as const).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => changeSource(option.value)}
                    disabled={isActive}
                    aria-pressed={leadSource === option.value}
                    title={
                      option.value === "stores"
                        ? "Retail buyers by store type and city, from Google Maps — chains filtered out"
                        : option.value === "maps"
                          ? "Any business type from Google Maps, including ones with no website"
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

            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              {leadSource === "stores" && hasZip && (
                <label className="flex items-center gap-2 text-[12px] font-bold text-[#464353]">
                  Around each ZIP:
                  <select
                    value={zipRadius}
                    onChange={(event) => setZipRadius(Number(event.target.value))}
                    disabled={isActive}
                    className="h-[33px] rounded-[9px] border border-[#d8d6e2] bg-white px-2 text-[11px] font-bold text-[#464353] outline-none focus:border-indigo"
                  >
                    <option value={0}>Only inside the ZIP</option>
                    <option value={2}>Within 2 miles</option>
                    <option value={5}>Within 5 miles</option>
                    <option value={10}>Within 10 miles</option>
                    <option value={25}>Within 25 miles</option>
                  </select>
                </label>
              )}
              <label
                className="flex cursor-pointer items-center gap-2 text-[12px] font-bold text-[#464353]"
                title="When on, every new lead with a phone number gets a real AI call (Retell) as soon as the run finishes"
              >
                <input
                  type="checkbox"
                  checked={autoOutreach}
                  onChange={(event) => setAutoOutreach(event.target.checked)}
                  disabled={isActive}
                  className="size-4 accent-indigo"
                />
                Auto-call new leads
              </label>

              {erpnext && (
                <Link
                  href="/integrations"
                  title={erpnext.connected ? erpnext.url : "Connect ERP to save leads there and skip ones you already have"}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold no-underline ${
                    erpnext.connected ? "bg-green-soft text-green" : "bg-[#f3f2f8] text-muted hover:text-indigo"
                  }`}
                >
                  <span className="size-1.5 rounded-full bg-current" />
                  {erpnext.connected
                    ? [erpnext.skipExisting && "Skipping ERP duplicates", erpnext.saveLeads && "Saving to ERP"]
                        .filter(Boolean)
                        .join(" · ") || "ERP connected (sync off)"
                    : "Connect ERP"}
                </Link>
              )}

              <label className="flex items-center gap-2.5" data-tour="limit">
                <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8a879a]">Lead target:</span>
                <select
                  value={resultLimit}
                  onChange={(event) => setResultLimit(Number(event.target.value))}
                  disabled={isActive}
                  className="h-[37px] min-w-[112px] rounded-[9px] border border-[#d8d6e2] bg-white px-2.5 text-[11px] font-bold text-[#464353] outline-none focus:border-indigo"
                >
                  {(leadSource === "stores" ? [10, 25, 50, 100, 250, 500, 1000] : [3, 5, 10, 15, 25]).map((value) => (
                    <option key={value} value={value}>
                      {value} {leadSource === "stores" ? "stores" : "leads"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {leadSource === "stores" && (
            <p className="m-0 mt-3 text-[11px] text-muted">
              {selectedTypes.length && pendingLocations.length
                ? `${plan.searches} Google searches (${selectedTypes.length} type${selectedTypes.length === 1 ? "" : "s"} × ${
                    pendingLocations.length
                  } location${pendingLocations.length === 1 ? "" : "s"}) · up to ${plan.budget} requests (≈ $${(
                    plan.budget * PLACES_COST_PER_REQUEST
                  ).toFixed(2)} max)`
                : "Pick store types and add at least one city."}
              {!autoOutreach && " · Leads are saved for review — start calls from the CRM page."}
            </p>
          )}
          {memoryHint && memoryHint.searches > 0 && (
            <p className="m-0 mt-1.5 text-[11px] text-muted">
              Continuing from earlier runs: {memoryHint.found.toLocaleString()} store{memoryHint.found === 1 ? "" : "s"} found
              here before {memoryHint.found === 1 ? "is" : "are"} skipped and each search picks up where it stopped
              {memoryHint.usedUp === memoryHint.searches &&
                (hasZip
                  ? " (the wide searches are used up — next runs search each ZIP in smaller areas)"
                  : " (every search is used up — add more cities or store types, or start over)")}
              .{" "}
              <button
                type="button"
                onClick={startSearchesOver}
                disabled={isActive}
                className="border-0 bg-transparent p-0 text-[11px] font-bold text-indigo hover:enabled:underline disabled:opacity-60"
              >
                Start over
              </button>
            </p>
          )}
          {leadSource === "stores" && selectedTypes.length > 0 && pendingLocations.length > 0 && plan.likelyStores < resultLimit && (
            <p className="m-0 mt-2 rounded-xl bg-[#fef4e6] px-3 py-2 text-[11px] leading-[1.5] text-[#8a520a]">
              Google returns at most {plan.maxListings.toLocaleString()} listings for these searches — after removing chains and
              duplicates expect roughly {plan.likelyStores.toLocaleString()} stores, short of {resultLimit.toLocaleString()}.
              Add more cities/ZIPs or store types to reach your target.
            </p>
          )}
          {leadSource === "stores" && resultLimit >= 250 && (
            <p className="m-0 mt-2 text-[11px] text-muted">
              Large runs take a while — reading each store&apos;s website for an email is the slow part (roughly{" "}
              {Math.max(1, Math.round((resultLimit * 0.7 * 3.5) / 60))} min for {resultLimit.toLocaleString()} stores).
            </p>
          )}
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
                onClick={() => setShowUpload(true)}
                className="inline-flex h-[43px] flex-none items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border border-[#dcdbe5] bg-white px-4 text-[12px] font-bold text-[#3f3d4d] hover:border-indigo hover:text-indigo"
              >
                <UploadIcon /> Import leads
              </button>
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
                  erpConnected={Boolean(erpnext?.connected)}
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
                  : "Describe your target market above and run your first search, or import a CSV/Excel file of leads."}
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
            {!isActive && status.status === "completed" && status.notice && (
              <p className="m-0 mt-3 rounded-xl bg-[#fef4e6] px-3 py-2 text-[11px] leading-[1.5] text-[#8a520a]" role="status">
                {status.notice}
              </p>
            )}
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
      {showStoreTypes && (
        <StoreTypesModal
          types={storeCatalog}
          onChange={(next) => {
            setStoreCatalog(next);
            // A newly added type is selected right away; removed ones drop out.
            setStoreTypes((current) => {
              const added = next.filter((type) => !type.hidden && !storeCatalog.some((old) => old.key === type.key));
              const kept = current.filter((key) => next.some((type) => type.key === key && !type.hidden));
              return [...kept, ...added.map((type) => type.key)];
            });
          }}
          onClose={() => setShowStoreTypes(false)}
        />
      )}
      {showUpload && (
        <UploadLeadsModal
          erpConnected={Boolean(erpnext?.connected)}
          onClose={() => setShowUpload(false)}
          onImported={() => void fetchState()}
        />
      )}
    </AppShell>
  );
}
