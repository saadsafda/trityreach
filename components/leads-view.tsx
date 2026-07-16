"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AddLeadModal from "@/components/add-lead-modal";
import ChannelStatus from "@/components/channel-status";
import ConversationThread from "@/components/conversation-thread";
import { ChevronRightIcon, DownloadIcon, EmailIcon, PhoneIcon, PlusIcon, SearchIcon } from "@/components/icons";
import TopNav from "@/components/top-nav";
import { leadKeyForClient } from "@/lib/lead-key";
import type { ConversationEntry, DashboardState, Lead, LeadField } from "@/lib/types";

type SendState = "sending" | "sent" | "error";
type OutreachChannel = "call" | "email";
type LeadSendState = { channel: OutreachChannel; state: SendState };

const COLUMNS: { key: LeadField; label: string }[] = [
  { key: "business_name", label: "Business" },
  { key: "contact_name", label: "Contact" },
  { key: "city", label: "City" },
  { key: "address", label: "Address" },
];

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

  const fetchData = useCallback(async () => {
    try {
      const [stateResponse, conversationsResponse] = await Promise.all([
        fetch("/api/state", { cache: "no-store" }),
        fetch("/api/conversations", { cache: "no-store" }),
      ]);
      const statePayload = (await stateResponse.json()) as DashboardState & { error?: string };
      if (!stateResponse.ok) throw new Error(statePayload.error || "Could not load leads");
      setLeads(statePayload.leads);

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
      if (channelFilter === "all") return true;
      const entries = conversationsByLead.get(leadKeyForClient(lead)) ?? [];
      if (channelFilter === "none") return entries.length === 0;
      return entries.some((entry) => entry.channel === channelFilter);
    });
  }, [leads, search, channelFilter, conversationsByLead]);

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

  function channelButtonLabel(leadKey: string, channel: OutreachChannel, idleLabel: string): string {
    const current = sendStates[leadKey];
    if (!current || current.channel !== channel) return idleLabel;
    if (current.state === "sending") return "Sending…";
    if (current.state === "sent") return channel === "call" ? "Called ✓" : "Sent ✓";
    return "Retry";
  }

  return (
    <main className="min-h-screen">
      <TopNav isActive={false} />

      <div className="shell py-[70px] pb-8">
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

        <section className="overflow-hidden rounded-[20px] border border-line bg-white shadow-panel">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-[26px] py-6">
            <div>
              <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Lead results</h2>
              <p className="m-0 text-[12px] text-muted">
                {visibleLeads.length} of {leads.length} leads
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex items-center gap-1 rounded-[11px] border border-[#dcdbe5] bg-white p-1">
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
              <label className="flex h-[43px] w-[220px] items-center gap-2 rounded-[11px] border border-[#dcdbe5] px-3 text-[#9996a5] focus-within:border-indigo focus-within:shadow-[0_0_0_3px_rgba(91,79,233,0.08)]">
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
                className="inline-flex h-[43px] items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border border-[#dcdbe5] bg-white px-4 text-[12px] font-bold text-[#3f3d4d] hover:border-indigo hover:text-indigo"
              >
                <PlusIcon /> Add lead
              </button>
              <button
                type="button"
                onClick={() => void callAllLeads()}
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

          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className="border-b border-line bg-[#fafafd] px-[17px] py-3.5 text-left text-[9px] font-extrabold uppercase tracking-[0.095em] text-[#777483]"
                    >
                      {column.label}
                    </th>
                  ))}
                  <th className="border-b border-line bg-[#fafafd] px-[17px] py-3.5 text-left text-[9px] font-extrabold uppercase tracking-[0.095em] text-[#777483]">
                    Channel status
                  </th>
                  <th className="border-b border-line bg-[#fafafd] px-[17px] py-3.5 text-right text-[9px] font-extrabold uppercase tracking-[0.095em] text-[#777483]">
                    Outreach
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleLeads.map((lead, index) => {
                  const leadKey = leadKeyForClient(lead);
                  const entries = conversationsByLead.get(leadKey) ?? [];
                  return (
                    <tr
                      key={`${lead.website}-${lead.email}-${index}`}
                      onClick={() => setSelectedLeadKey(leadKey)}
                      className="cursor-pointer hover:bg-[#fbfaff]"
                    >
                      <td className="max-w-[230px] border-b border-[#f0eff4] p-[17px] text-[12px] text-[#565363]">
                        <div className="flex items-center gap-2.5">
                          <span className="grid size-[31px] flex-none place-items-center rounded-[9px] bg-indigo-soft text-[11px] font-extrabold text-indigo">
                            {(lead.business_name || "?").charAt(0).toUpperCase()}
                          </span>
                          <strong className="truncate text-[12px] text-ink">{lead.business_name || "Not found"}</strong>
                        </div>
                      </td>
                      <td className="max-w-[200px] truncate border-b border-[#f0eff4] p-[17px] text-[12px] text-[#565363]">
                        {lead.contact_name || <span className="text-[#b9b7c0]">—</span>}
                      </td>
                      <td className="max-w-[160px] truncate border-b border-[#f0eff4] p-[17px] text-[12px] text-[#565363]">
                        {lead.city || <span className="text-[#b9b7c0]">—</span>}
                      </td>
                      <td className="max-w-[220px] truncate border-b border-[#f0eff4] p-[17px] text-[12px] text-[#565363]">
                        {lead.address || <span className="text-[#b9b7c0]">—</span>}
                      </td>
                      <td className="border-b border-[#f0eff4] p-[17px]">
                        <ChannelStatus entries={entries} />
                      </td>
                      <td className="border-b border-[#f0eff4] p-[17px]">
                        <div className="flex items-center justify-end gap-2 text-muted">
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
                          <ChevronRightIcon />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
          </div>
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

        <footer className="flex items-center justify-between px-[3px] pb-0.5 pt-6 text-[10px] text-[#9b99a5]">
          <span className="font-extrabold uppercase tracking-[0.11em] text-[#706d80]">AI Trity Reach</span>
          <p className="m-0">Local-first lead intelligence · Your data stays in this workspace</p>
        </footer>
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
    </main>
  );
}
