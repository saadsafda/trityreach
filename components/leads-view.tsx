"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AddLeadModal from "@/components/add-lead-modal";
import SendToErpButton from "@/components/send-to-erp-button";
import UploadLeadsModal from "@/components/upload-leads-modal";
import ChannelStatus from "@/components/channel-status";
import ConversationThread from "@/components/conversation-thread";
import {
  ChevronRightIcon,
  DownloadIcon,
  EmailIcon,
  GlobeIcon,
  MapPinIcon,
  PhoneIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  UploadIcon,
} from "@/components/icons";
import AppShell from "@/components/app-shell";
import { leadKeyForClient } from "@/lib/lead-key";
import type { ConversationEntry, DashboardState, ErpNextStatus, Lead } from "@/lib/types";

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

/** Heuristic from existing lead data — TrityReach doesn't persist a source tag per lead.
 * Google Maps is the only source that returns businesses with no website. */
function deriveLeadSource(lead: Lead): { label: string; icon: React.ReactNode } {
  return lead.website
    ? { label: "Web Lead", icon: <GlobeIcon /> }
    : { label: "Google Maps", icon: <MapPinIcon /> };
}

export default function LeadsView() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<"all" | "whatsapp" | "email" | "call" | "none">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedLeadKey, setSelectedLeadKey] = useState<string | null>(null);
  const [sendStates, setSendStates] = useState<Record<string, LeadSendState>>({});
  const [sendingAll, setSendingAll] = useState(false);
  const [showAddLead, setShowAddLead] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [storeTypeFilter, setStoreTypeFilter] = useState("all");
  const [erpnext, setErpnext] = useState<ErpNextStatus | null>(null);
  const [syncingErp, setSyncingErp] = useState(false);
  const [syncNotice, setSyncNotice] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const [stateResponse, conversationsResponse] = await Promise.all([
        fetch("/api/state", { cache: "no-store" }),
        fetch("/api/conversations", { cache: "no-store" }),
      ]);
      const statePayload = (await stateResponse.json()) as DashboardState & { error?: string };
      if (!stateResponse.ok) throw new Error(statePayload.error || "Could not load leads");
      setLeads(statePayload.leads);
      setErpnext(statePayload.erpnext);

      if (conversationsResponse.ok) {
        const conversationsPayload = (await conversationsResponse.json()) as { conversations: ConversationEntry[] };
        setConversations(conversationsPayload.conversations);
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Could not load leads");
    } finally {
      setLoading(false);
    }
  }, []);

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

  const visibleLeads = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return leads.filter((lead) => {
      const matchesSearch = !needle || Object.values(lead).some((value) => value.toLowerCase().includes(needle));
      if (!matchesSearch) return false;
      if (storeTypeFilter !== "all" && (lead.store_type || "") !== storeTypeFilter) return false;
      if (channelFilter === "all") return true;
      const entries = conversationsByLead.get(leadKeyForClient(lead)) ?? [];
      if (channelFilter === "none") return entries.length === 0;
      return entries.some((entry) => entry.channel === channelFilter);
    });
  }, [leads, search, channelFilter, storeTypeFilter, conversationsByLead]);

  const storeTypeOptions = useMemo(
    () => [...new Set(leads.map((lead) => lead.store_type).filter(Boolean))].sort(),
    [leads],
  );

  const selectedLead = useMemo(
    () => leads.find((lead) => leadKeyForClient(lead) === selectedLeadKey) ?? null,
    [leads, selectedLeadKey],
  );
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
    const callable = leads.filter((lead) => lead.phone).length;
    const confirmed = window.confirm(
      `Place a real AI phone call to all ${callable} lead(s) with a phone number? The Retell agent will call each business.`,
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
        for (const lead of leads) {
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
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-colors ${
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

        <section className="overflow-hidden rounded-[20px] border border-line bg-white shadow-panel">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-[26px] py-6">
            <div>
              <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Lead results</h2>
              <p className="m-0 text-[12px] text-muted">
                {visibleLeads.length} of {leads.length} leads
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
                    onClick={() => setChannelFilter(option.key)}
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
                  onChange={(event) => setStoreTypeFilter(event.target.value)}
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
                  onClick={() => void syncToErpNext()}
                  disabled={syncingErp || !leads.length}
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
                disabled={sendingAll || !leads.some((lead) => lead.phone)}
                className="inline-flex h-[43px] items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border border-indigo bg-indigo px-4 text-[12px] font-bold text-white shadow-button transition-transform hover:enabled:-translate-y-px hover:enabled:bg-indigo-dark"
              >
                {sendingAll ? (
                  <span className="size-3.5 animate-spin-fast rounded-full border-2 border-white/35 border-t-white" />
                ) : (
                  <PhoneIcon />
                )}
                {sendingAll ? "Calling…" : "Call all leads"}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3 p-4">
            {visibleLeads.map((lead, index) => {
              const leadKey = leadKeyForClient(lead);
              const entries = conversationsByLead.get(leadKey) ?? [];
              const status = STATUS_META[deriveLeadStatus(entries)];
              const source = deriveLeadSource(lead);
              return (
                <div
                  key={`${lead.website}-${lead.email}-${index}`}
                  onClick={() => setSelectedLeadKey(leadKey)}
                  data-tour={index === 0 ? "lead-row" : undefined}
                  className="flex cursor-pointer flex-col gap-3 rounded-2xl border border-[#f0eff4] bg-[#fbfbfd] p-4 transition-colors hover:border-[#dedaf9] lg:flex-row lg:items-center lg:justify-between lg:gap-4"
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

                  <div className="flex flex-wrap items-center gap-1.5">
                    {lead.store_type && (
                      <span className="rounded-full bg-indigo-soft px-2.5 py-1 text-[10px] font-bold text-indigo">
                        {lead.store_type}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#f1f0f5] px-2.5 py-1 text-[10px] font-bold text-[#696777]">
                      {source.icon}
                      {source.label}
                    </span>
                    <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${status.className}`}>
                      {status.label}
                    </span>
                    <ChannelStatus entries={entries} />
                  </div>

                  <div
                    className="flex flex-none items-center gap-2 text-muted"
                    data-tour={index === 0 ? "lead-actions" : undefined}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <OutreachButtons lead={lead} leadKey={leadKey} />
                    {erpnext?.connected && <SendToErpButton lead={lead} size="row" />}
                    <ChevronRightIcon />
                  </div>
                </div>
              );
            })}
          </div>

          {!loading && !visibleLeads.length && (
            <div className="flex min-h-[280px] flex-col items-center justify-center p-9 text-center">
              <h3 className="m-0 mb-1.5 text-[15px]">{leads.length ? "No leads match this filter" : "No leads yet"}</h3>
              <p className="m-0 text-[12px] text-muted">
                {leads.length ? "Try a different search or channel filter." : "Run a scrape from the Workflow page to get started."}
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

      {selectedLead && selectedLeadKey && (
        <ConversationThread
          lead={selectedLead}
          entries={selectedEntries}
          onClose={() => setSelectedLeadKey(null)}
          onSend={(channel) => void sendToOutreach(selectedLeadKey, channel)}
          sendState={sendStates[selectedLeadKey]}
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
