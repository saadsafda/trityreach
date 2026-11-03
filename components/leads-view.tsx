"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AddLeadModal from "@/components/add-lead-modal";
import LeadNotes from "@/components/lead-notes";
import SendToErpButton from "@/components/send-to-erp-button";
import UploadLeadsModal from "@/components/upload-leads-modal";
import ChannelStatus from "@/components/channel-status";
import ConversationThread from "@/components/conversation-thread";
import {
  ChevronRightIcon,
  DownloadIcon,
  EmailIcon,
  NoteIcon,
  PhoneIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  UploadIcon,
} from "@/components/icons";
import AppShell from "@/components/app-shell";
import { leadKeyForClient } from "@/lib/lead-key";
import type { ConversationEntry, DashboardState, ErpNextStatus, Lead, LeadOrigin, LeadPage, SavedLead } from "@/lib/types";

type SendState = "sending" | "sent" | "error";
type OutreachChannel = "call" | "email";
type LeadSendState = { channel: OutreachChannel; state: SendState };

type LeadStatus = "new" | "contacted" | "interested";

const STATUS_META: Record<LeadStatus, { label: string; className: string }> = {
  new: { label: "New", className: "bg-indigo-soft text-indigo" },
  contacted: { label: "Contacted", className: "bg-[#f1f0f5] text-[#696777]" },
  interested: { label: "Interested", className: "bg-green-soft text-green" },
};

/** Derived from real conversation history — no stored status field exists. */
function deriveLeadStatus(entries: ConversationEntry[]): LeadStatus {
  if (entries.some((entry) => entry.direction === "inbound")) return "interested";
  if (entries.length > 0) return "contacted";
  return "new";
}

const ORIGIN_LABELS: Record<LeadOrigin, string> = {
  search: "Search",
  manual: "Added by hand",
  import: "File import",
  erp: "From ERP",
};

const PAGE_SIZES = [10, 25, 50, 100];
const STICKY_HEADER_SPACE = 92;

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/** "1 … 4 5 6 … 20": the first, last, and neighbouring pages. */
function pageButtons(page: number, pageCount: number): (number | "gap")[] {
  const wanted = [...new Set([1, page - 1, page, page + 1, pageCount])]
    .filter((value) => value >= 1 && value <= pageCount)
    .sort((a, b) => a - b);
  const buttons: (number | "gap")[] = [];
  for (const value of wanted) {
    const previous = buttons[buttons.length - 1];
    if (typeof previous === "number" && value - previous === 2) buttons.push(previous + 1);
    else if (typeof previous === "number" && value - previous > 2) buttons.push("gap");
    buttons.push(value);
  }
  return buttons;
}

export default function LeadsView() {
  /** The page of saved leads on screen. */
  const [leads, setLeads] = useState<SavedLead[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [leadPage, setLeadPage] = useState<Omit<LeadPage, "leads"> | null>(null);
  /** The search box as sent to the server, a moment after typing stops. */
  const [appliedSearch, setAppliedSearch] = useState("");
  /** Which query the rows on screen answer, to dim them until the new page arrives. */
  const [loadedQuery, setLoadedQuery] = useState("");
  const latestRequest = useRef(0);
  const tableTop = useRef<HTMLElement>(null);
  const scrollWhenLoaded = useRef(false);
  /** The latest run plus hand-added leads: what "Call latest leads" calls. */
  const [latestLeads, setLatestLeads] = useState<Lead[]>([]);
  const [importingErp, setImportingErp] = useState(false);
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<"all" | "whatsapp" | "email" | "call" | "none">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedLead, setSelectedLead] = useState<SavedLead | null>(null);
  const [sendStates, setSendStates] = useState<Record<string, LeadSendState>>({});
  const [sendingAll, setSendingAll] = useState(false);
  const [showAddLead, setShowAddLead] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [storeTypeFilter, setStoreTypeFilter] = useState("all");
  const [erpnext, setErpnext] = useState<ErpNextStatus | null>(null);
  const [syncingErp, setSyncingErp] = useState(false);
  const [syncNotice, setSyncNotice] = useState("");

  const queryString = useMemo(
    () =>
      new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        search: appliedSearch,
        storeType: storeTypeFilter === "all" ? "" : storeTypeFilter,
        channel: channelFilter,
      }).toString(),
    [page, pageSize, appliedSearch, storeTypeFilter, channelFilter],
  );

  const fetchData = useCallback(async () => {
    const request = ++latestRequest.current;
    try {
      const [stateResponse, leadsResponse, conversationsResponse] = await Promise.all([
        fetch("/api/state", { cache: "no-store" }),
        fetch(`/api/leads?${queryString}`, { cache: "no-store" }),
        fetch("/api/conversations", { cache: "no-store" }),
      ]);
      // A newer request (another page or filter) has taken over.
      if (request !== latestRequest.current) return;
      const statePayload = (await stateResponse.json()) as DashboardState & { error?: string };
      if (!stateResponse.ok) throw new Error(statePayload.error || "Could not load leads");
      const leadsPayload = (await leadsResponse.json()) as LeadPage & { error?: string };
      if (!leadsResponse.ok) throw new Error(leadsPayload.error || "Could not load leads");
      setLeads(leadsPayload.leads);
      setLeadPage(leadsPayload);
      setLoadedQuery(queryString);
      // The list shrank under this page (filter, fewer results): go to its last page.
      if (leadsPayload.page !== page) setPage(leadsPayload.page);
      setLatestLeads(statePayload.leads);
      setErpnext(statePayload.erpnext);

      if (conversationsResponse.ok) {
        const conversationsPayload = (await conversationsResponse.json()) as { conversations: ConversationEntry[] };
        setConversations(conversationsPayload.conversations);
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Could not load leads");
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, [queryString, page]);

  useEffect(() => {
    const next = search.trim();
    if (next === appliedSearch) return;
    const timer = window.setTimeout(() => {
      setAppliedSearch(next);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, appliedSearch]);

  useEffect(() => {
    const initial = window.setTimeout(() => void fetchData(), 0);
    const interval = window.setInterval(() => void fetchData(), 4000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [fetchData]);

  const conversationsByLead = useMemo(() => {
    const map = new Map<string, ConversationEntry[]>();
    for (const entry of conversations) {
      const list = map.get(entry.leadKey) ?? [];
      list.push(entry);
      map.set(entry.leadKey, list);
    }
    return map;
  }, [conversations]);

  const total = leadPage?.total ?? 0;
  const allTotal = leadPage?.allTotal ?? 0;
  const pageCount = leadPage?.pageCount ?? 1;
  const storeTypeOptions = leadPage?.storeTypes ?? [];
  const firstRow = total ? ((leadPage?.page ?? 1) - 1) * (leadPage?.pageSize ?? pageSize) + 1 : 0;
  const lastRow = total ? firstRow + leads.length - 1 : 0;

  function goToPage(next: number) {
    setPage(next);
    scrollWhenLoaded.current = true;
  }

  // Back to the top of the table, clear of the sticky page header. This waits
  // for the new rows: a shorter page arriving mid-scroll cancels the scroll.
  useEffect(() => {
    if (!scrollWhenLoaded.current || loadedQuery !== queryString) return;
    scrollWhenLoaded.current = false;
    const top = tableTop.current?.getBoundingClientRect().top;
    if (top !== undefined && top < STICKY_HEADER_SPACE) {
      window.scrollBy({ top: top - STICKY_HEADER_SPACE, behavior: "smooth" });
    }
  }, [loadedQuery, queryString]);

  /** Stays open with its latest data, even if the row leaves this page meanwhile. */
  const openLead = selectedLead ? (leads.find((lead) => lead.id === selectedLead.id) ?? selectedLead) : null;
  /** Empty for a lead with no email or phone: nothing to log or send. */
  const selectedLeadKey = openLead ? leadKeyForClient(openLead) : "";
  const selectedEntries = selectedLeadKey ? conversationsByLead.get(selectedLeadKey) ?? [] : [];

  const sendToOutreach = useCallback(async (leadKey: string, channel: OutreachChannel) => {
    setError("");
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
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Could not send to outreach");
      setSendStates((current) => ({ ...current, [leadKey]: { channel, state: "error" } }));
    }
  }, []);

  async function callAllLeads() {
    const callable = latestLeads.filter((lead) => lead.phone).length;
    const confirmed = window.confirm(
      `Place a real AI phone call to the ${callable} lead(s) with a phone number from your latest search and the ones added by hand? Older leads are not called. The Retell agent will call each business.`,
    );
    if (!confirmed) return;
    setError("");
    setSendingAll(true);
    try {
      const response = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true, channel: "call" }),
      });
      const payload = (await response.json()) as { sent?: number; failed?: string[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not start the calls");
      setSendStates((current) => {
        const next = { ...current };
        for (const lead of latestLeads) {
          const key = leadKeyForClient(lead);
          if (key && lead.phone) {
            const state: SendState = payload.failed?.includes(lead.business_name || lead.website || "lead")
              ? "error"
              : "sent";
            next[key] = { channel: "call", state };
          }
        }
        return next;
      });
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Could not start the calls");
    } finally {
      setSendingAll(false);
    }
  }

  async function importFromErp() {
    setError("");
    setSyncNotice("");
    setImportingErp(true);
    try {
      const response = await fetch("/api/leads/import-erp", { method: "POST" });
      const payload = (await response.json()) as { total?: number; added?: number; updated?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not import from ERP");
      setSyncNotice(
        `Read ${payload.total ?? 0} lead(s) from ERP: ${payload.added ?? 0} added to the CRM, ${payload.updated ?? 0} already here got missing details filled.`,
      );
      await fetchData();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Could not import from ERP");
    } finally {
      setImportingErp(false);
    }
  }

  async function syncToErpNext() {
    setError("");
    setSyncNotice("");
    setSyncingErp(true);
    try {
      const response = await fetch("/api/erpnext/sync", { method: "POST" });
      const payload = (await response.json()) as {
        created?: number;
        skipped?: number;
        failed?: { business: string; error: string }[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Could not sync with ERP");
      const failed = payload.failed ?? [];
      setSyncNotice(
        `ERP sync: ${payload.created ?? 0} created, ${payload.skipped ?? 0} already there` +
          (failed.length ? `, ${failed.length} failed (${failed.map((item) => `${item.business}: ${item.error}`).join("; ")})` : "."),
      );
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Could not sync with ERP");
    } finally {
      setSyncingErp(false);
    }
  }

  function channelButtonLabel(leadKey: string, channel: OutreachChannel, idleLabel: string): string {
    const current = sendStates[leadKey];
    if (!current || current.channel !== channel) return idleLabel;
    if (current.state === "sending") return "Sending…";
    if (current.state === "sent") return channel === "call" ? "Called ✓" : "Sent ✓";
    return "Retry";
  }

  function OutreachButtons({ lead, leadKey }: { lead: Lead; leadKey: string }) {
    return (
      <>
        {(
          [
            { channel: "call" as const, icon: <PhoneIcon />, idle: "Call", enabled: Boolean(lead.phone), missing: "Needs a phone number" },
            { channel: "email" as const, icon: <EmailIcon />, idle: "Email", enabled: Boolean(lead.email), missing: "Needs an email address" },
          ]
        ).map(({ channel, icon, idle, enabled, missing }) => {
          const current = sendStates[leadKey];
          const isThis = current?.channel === channel;
          return (
            <button
              key={channel}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void sendToOutreach(leadKey, channel);
              }}
              disabled={!enabled || current?.state === "sending"}
              title={
                enabled
                  ? channel === "call"
                    ? "Place a real AI phone call to this lead"
                    : "Send a real AI-drafted email to this lead"
                  : missing
              }
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-colors ${
                isThis && current.state === "sent"
                  ? "border-green/30 bg-green-soft text-green"
                  : isThis && current.state === "error"
                    ? "border-red/30 bg-red-soft text-red"
                    : "border-[#dcdbe5] bg-white text-[#3f3d4d] hover:enabled:border-indigo hover:enabled:text-indigo"
              }`}
            >
              {isThis && current.state === "sending" ? (
                <span className="size-3 animate-spin-fast rounded-full border-2 border-indigo/25 border-t-indigo" />
              ) : (
                icon
              )}
              {channelButtonLabel(leadKey, channel, idle)}
            </button>
          );
        })}
      </>
    );
  }

  return (
    <AppShell isActive={false}>
      <div className="mx-auto w-full max-w-[1240px] px-5 py-10 md:px-9 md:py-14">
        <section className="mb-6 max-w-[640px] px-2">
          <div className="mb-4 flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-[0.14em] text-indigo">
            CRM &amp; conversations
          </div>
          <h1 className="m-0 text-[clamp(32px,3.6vw,46px)] font-bold leading-[1.02] tracking-[-0.04em]">
            Every lead. <span className="text-indigo">Every message.</span>
          </h1>
          <p className="mt-4 max-w-[560px] text-[15px] leading-[1.7] text-muted">
            See how each lead was reached and open any row to read the exact message, script, or note that was sent.
          </p>
        </section>

        {error && (
          <div className="mb-5 flex gap-2.5 rounded-xl border border-[#ffd5dc] bg-[#fff5f6] px-4 py-3.5 text-[12px] text-[#9e3043]" role="alert">
            <strong className="flex-none">Something needs attention</strong>
            <span>{error}</span>
          </div>
        )}

        {syncNotice && !error && (
          <div className="mb-5 flex gap-2.5 rounded-xl bg-indigo-soft px-4 py-3.5 text-[12px] text-indigo" role="status">
            {syncNotice}
          </div>
        )}

        <section ref={tableTop} className="overflow-hidden rounded-[20px] border border-line bg-white shadow-panel">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-[26px] py-6">
            <div>
              <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">All saved leads</h2>
              <p className="m-0 text-[12px] text-muted">
                {total === allTotal
                  ? `${allTotal.toLocaleString()} lead${allTotal === 1 ? "" : "s"}`
                  : `${total.toLocaleString()} of ${allTotal.toLocaleString()} leads match`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex items-center gap-1 rounded-[11px] border border-[#dcdbe5] bg-white p-1" data-tour="filters">
                {(
                  [
                    { key: "all", label: "All" },
                    { key: "whatsapp", label: "WhatsApp" },
                    { key: "email", label: "Email" },
                    { key: "call", label: "Call" },
                    { key: "none", label: "Not contacted" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => {
                      setChannelFilter(option.key);
                      setPage(1);
                    }}
                    className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                      channelFilter === option.key ? "bg-indigo-soft text-indigo" : "text-muted hover:text-ink"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {storeTypeOptions.length > 0 && (
                <select
                  value={storeTypeFilter}
                  onChange={(event) => {
                    setStoreTypeFilter(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Filter by store type"
                  className="h-[43px] rounded-[11px] border border-[#dcdbe5] bg-white px-3 text-[12px] font-semibold text-[#3f3d4d] outline-none focus:border-indigo"
                >
                  <option value="all">All store types</option>
                  {storeTypeOptions.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              )}
              <label
                className="flex h-[43px] w-full items-center gap-2 rounded-[11px] border border-[#dcdbe5] px-3 text-[#9996a5] focus-within:border-indigo focus-within:shadow-[0_0_0_3px_rgba(91,79,233,0.08)] sm:w-[220px]"
                data-tour="crm-search"
              >
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
                onClick={() => setShowAddLead(true)}
                data-tour="add-lead"
                className="inline-flex h-[43px] items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border border-[#dcdbe5] bg-white px-4 text-[12px] font-bold text-[#3f3d4d] hover:border-indigo hover:text-indigo"
              >
                <PlusIcon /> Add lead
              </button>
              <button
                type="button"
                onClick={() => setShowUpload(true)}
                data-tour="upload-leads"
                className="inline-flex h-[43px] items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border border-[#dcdbe5] bg-white px-4 text-[12px] font-bold text-[#3f3d4d] hover:border-indigo hover:text-indigo"
              >
                <UploadIcon /> Upload leads
              </button>
              {erpnext?.connected && (
                <button
                  type="button"
                  onClick={() => void importFromErp()}
                  disabled={importingErp}
                  title={`Copy every Lead from ${erpnext.url} into this CRM. Nothing in ERP changes.`}
                  className="inline-flex h-[43px] items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border border-[#dcdbe5] bg-white px-4 text-[12px] font-bold text-[#3f3d4d] hover:enabled:border-indigo hover:enabled:text-indigo"
                >
                  {importingErp ? (
                    <span className="size-3.5 animate-spin-fast rounded-full border-2 border-indigo/25 border-t-indigo" />
                  ) : (
                    <DownloadIcon />
                  )}
                  {importingErp ? "Importing…" : "Import from ERP"}
                </button>
              )}
              {erpnext?.connected && (
                <button
                  type="button"
                  onClick={() => void syncToErpNext()}
                  disabled={syncingErp || !allTotal}
                  title={`Create every lead that isn't in ${erpnext.url} yet`}
                  className="inline-flex h-[43px] items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border border-[#dcdbe5] bg-white px-4 text-[12px] font-bold text-[#3f3d4d] hover:enabled:border-indigo hover:enabled:text-indigo"
                >
                  {syncingErp ? (
                    <span className="size-3.5 animate-spin-fast rounded-full border-2 border-indigo/25 border-t-indigo" />
                  ) : (
                    <RefreshIcon />
                  )}
                  {syncingErp ? "Syncing…" : "Sync to ERP"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void callAllLeads()}
                data-tour="call-all"
                disabled={sendingAll || !latestLeads.some((lead) => lead.phone)}
                title="Calls the leads from your latest search and the ones added by hand, not every saved lead"
                className="inline-flex h-[43px] items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border border-indigo bg-indigo px-4 text-[12px] font-bold text-white shadow-button transition-transform hover:enabled:-translate-y-px hover:enabled:bg-indigo-dark"
              >
                {sendingAll ? (
                  <span className="size-3.5 animate-spin-fast rounded-full border-2 border-white/35 border-t-white" />
                ) : (
                  <PhoneIcon />
                )}
                {sendingAll ? "Calling…" : "Call latest leads"}
              </button>
            </div>
          </div>

          {leads.length > 0 && (
            <div
              className={`overflow-x-auto transition-opacity ${loadedQuery === queryString ? "" : "opacity-50"}`}
              aria-busy={loadedQuery !== queryString}
            >
              <table className="w-full min-w-[1040px] table-fixed border-collapse text-left">
                <colgroup>
                  <col />
                  <col className="w-[165px]" />
                  <col className="w-[142px]" />
                  <col className="w-[116px]" />
                  <col className="w-[96px]" />
                  <col className="w-[352px]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-line bg-[#fbfbfd] text-[10px] font-extrabold uppercase tracking-[0.09em] text-[#8a879a]">
                    <th scope="col" className="py-3 pr-3 pl-[26px] font-extrabold">Lead</th>
                    <th scope="col" className="p-3 font-extrabold">Contact</th>
                    <th scope="col" className="p-3 font-extrabold">Store type</th>
                    <th scope="col" className="p-3 font-extrabold">Status</th>
                    <th scope="col" className="p-3 font-extrabold">Added</th>
                    <th scope="col" className="py-3 pr-[26px] pl-3 text-right font-extrabold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead, index) => {
                    const leadKey = leadKeyForClient(lead);
                    const entries = conversationsByLead.get(leadKey) ?? [];
                    const status = STATUS_META[deriveLeadStatus(entries)];
                    return (
                      <tr
                        key={lead.id}
                        onClick={() => setSelectedLead(lead)}
                        data-tour={index === 0 ? "lead-row" : undefined}
                        className="cursor-pointer border-b border-[#f0eff4] align-middle transition-colors last:border-b-0 hover:bg-[#fbfbfd]"
                      >
                        <td className="py-3 pr-3 pl-[26px]">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedLead(lead);
                            }}
                            title={lead.business_name}
                            className="block w-full truncate border-0 bg-transparent p-0 text-left text-[13px] font-bold text-ink hover:text-indigo"
                          >
                            {lead.business_name || "Not found"}
                          </button>
                          <span className="block truncate text-[11px] text-muted">
                            {[lead.contact_name, lead.city].filter(Boolean).join(" · ") || "No contact name"}
                          </span>
                        </td>
                        <td className="p-3 text-[11px]" onClick={(event) => event.stopPropagation()}>
                          {lead.phone ? (
                            <a href={`tel:${lead.phone}`} className="block truncate text-[#454254] tabular-nums no-underline hover:text-indigo">
                              {lead.phone}
                            </a>
                          ) : (
                            <span className="block italic text-[#a3a1b0]">No phone</span>
                          )}
                          {lead.email ? (
                            <a href={`mailto:${lead.email}`} title={lead.email} className="block truncate text-muted no-underline hover:text-indigo">
                              {lead.email}
                            </a>
                          ) : (
                            <span className="block italic text-[#a3a1b0]">No email</span>
                          )}
                        </td>
                        <td className="p-3">
                          {lead.store_type ? (
                            <span
                              title={lead.store_type}
                              className="inline-block max-w-full truncate rounded-full bg-indigo-soft px-2.5 py-1 align-middle text-[10px] font-bold text-indigo"
                            >
                              {lead.store_type}
                            </span>
                          ) : (
                            <span className="text-[11px] text-[#b9b7c0]">None</span>
                          )}
                        </td>
                        <td className="p-3">
                          <div className="flex flex-col items-start gap-1">
                            <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${status.className}`}>{status.label}</span>
                            <ChannelStatus entries={entries} />
                          </div>
                        </td>
                        <td className="p-3 text-[11px]">
                          <span className="block truncate text-[#454254] tabular-nums">{formatDate(lead.savedAt)}</span>
                          <span className="block truncate text-muted">{ORIGIN_LABELS[lead.origin]}</span>
                        </td>
                        <td className="py-3 pr-[26px] pl-3" onClick={(event) => event.stopPropagation()}>
                          <div className="flex flex-wrap items-center justify-end gap-1.5" data-tour={index === 0 ? "lead-actions" : undefined}>
                            <OutreachButtons lead={lead} leadKey={leadKey} />
                            {erpnext?.connected && <SendToErpButton lead={lead} size="row" />}
                            <button
                              type="button"
                              onClick={() => setSelectedLead(lead)}
                              title={lead.latestNote || "Add a note to this lead"}
                              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-colors ${
                                lead.noteCount
                                  ? "border-indigo/25 bg-indigo-soft text-indigo"
                                  : "border-[#dcdbe5] bg-white text-[#3f3d4d] hover:border-indigo hover:text-indigo"
                              }`}
                            >
                              <NoteIcon />
                              {lead.noteCount ? `Notes (${lead.noteCount})` : "Notes"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {leads.length > 0 && (
            <nav
              aria-label="Lead pages"
              className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-[26px] py-4"
            >
              <div className="flex flex-wrap items-center gap-4 text-[12px] text-muted">
                <span className="tabular-nums">
                  Showing {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of {total.toLocaleString()}
                </span>
                <label className="flex items-center gap-2">
                  Rows per page
                  <select
                    value={pageSize}
                    onChange={(event) => {
                      setPageSize(Number(event.target.value));
                      setPage(1);
                    }}
                    className="h-[33px] rounded-[9px] border border-[#d8d6e2] bg-white px-2 text-[12px] font-semibold text-[#3f3d4d] outline-none focus:border-indigo"
                  >
                    {PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Previous page"
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1}
                  className="grid size-[33px] place-items-center rounded-[9px] border border-[#dcdbe5] bg-white text-[#3f3d4d] hover:enabled:border-indigo hover:enabled:text-indigo"
                >
                  <span className="grid rotate-180">
                    <ChevronRightIcon />
                  </span>
                </button>
                {pageButtons(page, pageCount).map((value, index) =>
                  value === "gap" ? (
                    <span key={`gap-${index}`} className="px-1 text-[12px] text-muted">
                      …
                    </span>
                  ) : (
                    <button
                      key={value}
                      type="button"
                      onClick={() => goToPage(value)}
                      aria-current={value === page ? "page" : undefined}
                      className={`h-[33px] min-w-[33px] rounded-[9px] border px-2 text-[12px] font-bold tabular-nums transition-colors ${
                        value === page
                          ? "border-indigo bg-indigo text-white"
                          : "border-[#dcdbe5] bg-white text-[#3f3d4d] hover:border-indigo hover:text-indigo"
                      }`}
                    >
                      {value.toLocaleString()}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  aria-label="Next page"
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= pageCount}
                  className="grid size-[33px] place-items-center rounded-[9px] border border-[#dcdbe5] bg-white text-[#3f3d4d] hover:enabled:border-indigo hover:enabled:text-indigo"
                >
                  <ChevronRightIcon />
                </button>
              </div>
            </nav>
          )}

          {!loading && !leads.length && (
            <div className="flex min-h-[280px] flex-col items-center justify-center p-9 text-center">
              <h3 className="m-0 mb-1.5 text-[15px]">{allTotal ? "No leads match this filter" : "No leads yet"}</h3>
              <p className="m-0 text-[12px] text-muted">
                {allTotal ? "Try a different search or channel filter." : "Run a search on the Discovery page to get started."}
              </p>
            </div>
          )}
          {loading && (
            <div className="flex min-h-[280px] flex-col items-center justify-center p-9 text-center">
              <span className="mb-3.5 size-4 animate-spin-fast rounded-full border-2 border-indigo/15 border-t-indigo" />
              <h3 className="m-0 mb-1.5 text-[15px]">Loading your workspace</h3>
            </div>
          )}
        </section>

        <div className="flex items-center justify-center pt-4">
          <button
            type="button"
            onClick={() => void fetchData()}
            className="inline-flex items-center gap-2 rounded-[11px] border border-[#dcdbe5] bg-white px-4 py-2 text-[11px] font-bold text-[#3f3d4d] hover:border-indigo hover:text-indigo"
          >
            <DownloadIcon /> Refresh
          </button>
        </div>
      </div>

      {openLead && (
        <ConversationThread
          lead={openLead}
          entries={selectedEntries}
          onClose={() => setSelectedLead(null)}
          onSend={selectedLeadKey ? (channel) => void sendToOutreach(selectedLeadKey, channel) : undefined}
          sendState={sendStates[selectedLeadKey]}
          notes={<LeadNotes key={openLead.id} leadId={openLead.id} onChanged={() => void fetchData()} />}
        />
      )}

      {showAddLead && <AddLeadModal onClose={() => setShowAddLead(false)} onAdded={() => void fetchData()} />}
      {showUpload && (
        <UploadLeadsModal
          erpConnected={Boolean(erpnext?.connected)}
          onClose={() => setShowUpload(false)}
          onImported={() => void fetchData()}
        />
      )}
    </AppShell>
  );
}
