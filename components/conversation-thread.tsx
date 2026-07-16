"use client";

import { useEffect } from "react";
import { BuildingIcon, CloseIcon, EmailIcon, PhoneIcon, WhatsAppIcon } from "@/components/icons";
import type { ConversationChannel, ConversationEntry, Lead } from "@/lib/types";

const CHANNEL_META: Record<ConversationChannel, { label: string; icon: React.ReactNode; badge: string }> = {
  whatsapp: { label: "WhatsApp", icon: <WhatsAppIcon />, badge: "bg-green-soft text-green" },
  email: { label: "Email", icon: <EmailIcon />, badge: "bg-blue-soft text-blue" },
  call: { label: "AI Call", icon: <PhoneIcon />, badge: "bg-purple-soft text-purple" },
  crm: { label: "CRM", icon: <BuildingIcon />, badge: "bg-[#f1f0f5] text-[#696777]" },
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function ConversationThread({
  lead,
  entries,
  onClose,
  onSend,
  sendState,
}: {
  lead: Lead;
  entries: ConversationEntry[];
  onClose: () => void;
  /** Sends this lead to the n8n outreach workflow on the chosen channel.
   * Omit to hide the outreach buttons. */
  onSend?: (channel: "call" | "email") => void;
  sendState?: { channel: string; state: "sending" | "sent" | "error" };
}) {
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const ordered = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button
        type="button"
        aria-label="Close conversation panel"
        onClick={onClose}
        className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]"
      />
      <aside className="relative flex h-full w-full max-w-[460px] flex-col bg-white shadow-[-24px_0_60px_rgba(31,26,75,0.12)]">
        <div className="flex items-start justify-between gap-3 border-b border-line px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="grid size-[38px] flex-none place-items-center rounded-[11px] bg-indigo-soft text-[13px] font-extrabold text-indigo">
              {(lead.business_name || "?").charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <h2 className="m-0 truncate text-[15px] tracking-[-0.01em]">{lead.business_name || "Unknown business"}</h2>
              <p className="m-0 truncate text-[12px] text-muted">
                {[lead.contact_name, lead.city].filter(Boolean).join(" · ") || "No contact details yet"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 flex-none place-items-center rounded-lg text-muted hover:bg-[#f4f3f8] hover:text-ink"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex flex-wrap gap-2 border-b border-line bg-[#fbfbfd] px-6 py-3.5 text-[11px] text-muted">
          {lead.email && (
            <a href={`mailto:${lead.email}`} className="rounded-full border border-line bg-white px-2.5 py-1 text-indigo hover:underline">
              {lead.email}
            </a>
          )}
          {lead.phone && (
            <a href={`tel:${lead.phone}`} className="rounded-full border border-line bg-white px-2.5 py-1 text-indigo hover:underline">
              {lead.phone}
            </a>
          )}
          {lead.website && (
            <a
              href={lead.website}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-line bg-white px-2.5 py-1 text-indigo hover:underline"
            >
              {lead.website.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
            </a>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <h3 className="m-0 mb-4 text-[11px] font-extrabold uppercase tracking-[0.09em] text-muted">Conversation thread</h3>
          {ordered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-14 text-center">
              <p className="text-[13px] font-semibold text-ink">No outreach logged yet</p>
              <p className="max-w-[280px] text-[12px] text-muted">
                Once n8n sends a message or places a call for this lead, the exact content will appear here.
              </p>
            </div>
          ) : (
            <ol className="flex flex-col gap-4">
              {ordered.map((entry) => {
                const meta = CHANNEL_META[entry.channel];
                return (
                  <li key={entry.id} className="rounded-2xl border border-line bg-[#fbfbfd] p-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold ${meta.badge}`}>
                        {meta.icon}
                        {meta.label}
                        <span className="opacity-60">· {entry.direction === "inbound" ? "received" : "sent"}</span>
                      </span>
                      <span className="text-[10px] text-muted">{formatTimestamp(entry.createdAt)}</span>
                    </div>
                    {entry.subject && <p className="m-0 mb-1 text-[12px] font-semibold text-ink">{entry.subject}</p>}
                    <p className="m-0 whitespace-pre-wrap text-[13px] leading-[1.6] text-[#454254]">{entry.content}</p>
                    {entry.status && (
                      <p className="m-0 mt-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">{entry.status}</p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {onSend && (
          <div className="flex items-center justify-between gap-3 border-t border-line bg-[#fbfbfd] px-6 py-4">
            <p className="m-0 text-[11px] leading-[1.5] text-muted">
              Pick a channel — the AI drafts the message or script, then it is really sent.
            </p>
            <div className="flex flex-none items-center gap-2">
              <button
                type="button"
                onClick={() => onSend("call")}
                disabled={!lead.phone || sendState?.state === "sending"}
                title={lead.phone ? "Place a real AI phone call" : "Needs a phone number"}
                className={`inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border px-4 text-[12px] font-bold transition-transform ${
                  sendState?.channel === "call" && sendState.state === "sent"
                    ? "border-green/30 bg-green-soft text-green"
                    : "border-indigo bg-indigo text-white shadow-button hover:enabled:-translate-y-px hover:enabled:bg-indigo-dark"
                }`}
              >
                {sendState?.channel === "call" && sendState.state === "sending" ? (
                  <span className="size-3.5 animate-spin-fast rounded-full border-2 border-white/35 border-t-white" />
                ) : (
                  <PhoneIcon />
                )}
                {sendState?.channel === "call" && sendState.state === "sent"
                  ? "Called ✓"
                  : sendState?.channel === "call" && sendState.state === "sending"
                    ? "Calling…"
                    : "Call now"}
              </button>
              <button
                type="button"
                onClick={() => onSend("email")}
                disabled={!lead.email || sendState?.state === "sending"}
                title={lead.email ? "Send a real AI-drafted email" : "Needs an email address"}
                className={`inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border px-4 text-[12px] font-bold transition-colors ${
                  sendState?.channel === "email" && sendState.state === "sent"
                    ? "border-green/30 bg-green-soft text-green"
                    : "border-[#dcdbe5] bg-white text-[#3f3d4d] hover:enabled:border-indigo hover:enabled:text-indigo"
                }`}
              >
                {sendState?.channel === "email" && sendState.state === "sending" ? (
                  <span className="size-3.5 animate-spin-fast rounded-full border-2 border-indigo/25 border-t-indigo" />
                ) : (
                  <EmailIcon />
                )}
                {sendState?.channel === "email" && sendState.state === "sent"
                  ? "Sent ✓"
                  : sendState?.channel === "email" && sendState.state === "sending"
                    ? "Sending…"
                    : "Send email"}
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
