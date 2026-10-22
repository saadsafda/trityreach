"use client";

import { useState } from "react";
import { PlugIcon } from "@/components/icons";
import type { Lead } from "@/lib/types";

type ErpSendState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "created"; name: string; url: string }
  | { state: "exists"; reason: string }
  | { state: "error"; message: string };

/** Creates this one lead as a record in the connected ERPNext. Leads ERPNext
 * already has (same email, phone, website, or name + city) are not duplicated. */
export default function SendToErpButton({ lead, size = "card" }: { lead: Lead; size?: "card" | "row" }) {
  const [send, setSend] = useState<ErpSendState>({ state: "idle" });

  async function sendToErp() {
    setSend({ state: "saving" });
    try {
      const response = await fetch("/api/erpnext/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead }),
      });
      const payload = (await response.json()) as {
        status?: "created" | "exists";
        name?: string;
        url?: string;
        reason?: string;
        error?: string;
      };
      if (!response.ok || !payload.status) throw new Error(payload.error || "Could not save to ERP");
      setSend(
        payload.status === "created"
          ? { state: "created", name: payload.name ?? "", url: payload.url ?? "" }
          : { state: "exists", reason: payload.reason ?? "" },
      );
    } catch (error) {
      setSend({ state: "error", message: error instanceof Error ? error.message : "Could not save to ERP" });
    }
  }

  const base = `inline-flex flex-none items-center justify-center gap-1.5 whitespace-nowrap border font-bold no-underline transition-colors disabled:opacity-100 ${
    size === "card" ? "h-[38px] rounded-[11px] px-3 text-[12px]" : "rounded-lg px-2.5 py-1.5 text-[11px]"
  }`;

  if (send.state === "created" && send.url) {
    return (
      <a
        href={send.url}
        target="_blank"
        rel="noreferrer"
        title={`Created ${send.name} in ERP — open it`}
        className={`${base} border-green/30 bg-green-soft text-green`}
      >
        <PlugIcon />
        Saved ✓
      </a>
    );
  }

  const label = {
    idle: "To ERP",
    saving: "Saving…",
    created: "Saved ✓",
    exists: "In ERP ✓",
    error: "Retry",
  }[send.state];
  const title = {
    idle: "Create a lead record for this store in ERP",
    saving: "Saving to ERP…",
    created: "Created in ERP",
    exists: `Already in ERP (matched on ${send.state === "exists" ? send.reason : ""})`,
    error: send.state === "error" ? send.message : "",
  }[send.state];

  return (
    <button
      type="button"
      onClick={() => void sendToErp()}
      disabled={send.state === "saving" || send.state === "created" || send.state === "exists"}
      title={title}
      className={`${base} ${
        send.state === "created" || send.state === "exists"
          ? "border-green/30 bg-green-soft text-green"
          : send.state === "error"
            ? "border-red/30 bg-red-soft text-red"
            : send.state === "saving"
              ? "border-[#dcdbe5] bg-white text-muted"
              : "border-[#dcdbe5] bg-white text-[#3f3d4d] hover:border-indigo hover:text-indigo"
      }`}
    >
      {send.state === "saving" ? (
        <span className="size-3 animate-spin-fast rounded-full border-2 border-indigo/25 border-t-indigo" />
      ) : (
        <PlugIcon />
      )}
      {label}
    </button>
  );
}
