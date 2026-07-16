"use client";

import { EmailIcon, PhoneIcon, WhatsAppIcon } from "@/components/icons";
import type { ConversationChannel, ConversationEntry } from "@/lib/types";

const CHANNEL_ORDER: ConversationChannel[] = ["whatsapp", "email", "call"];

const CHANNEL_STYLES: Record<ConversationChannel, { label: string; icon: React.ReactNode; className: string }> = {
  whatsapp: { label: "WhatsApp", icon: <WhatsAppIcon />, className: "bg-green-soft text-green" },
  email: { label: "Email", icon: <EmailIcon />, className: "bg-blue-soft text-blue" },
  call: { label: "Call", icon: <PhoneIcon />, className: "bg-purple-soft text-purple" },
  crm: { label: "CRM", icon: null, className: "bg-[#f1f0f5] text-[#696777]" },
};

/** Shows a small colored badge per channel this lead has been contacted on. */
export default function ChannelStatus({ entries }: { entries: ConversationEntry[] }) {
  const channelsUsed = CHANNEL_ORDER.filter((channel) => entries.some((entry) => entry.channel === channel));

  if (channelsUsed.length === 0) {
    return <span className="text-[11px] font-medium text-[#b9b7c0]">Not contacted</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {channelsUsed.map((channel) => {
        const style = CHANNEL_STYLES[channel];
        return (
          <span
            key={channel}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold ${style.className}`}
          >
            {style.icon}
            {style.label}
          </span>
        );
      })}
    </div>
  );
}
