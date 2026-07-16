import { NextResponse } from "next/server";
import { leadKeyForClient } from "@/lib/lead-key";
import { appendActivityEvent, ensureDataDirectory, readLeads } from "@/lib/storage";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";

const CHANNELS = ["call", "email", "whatsapp"] as const;
type OutreachChannel = (typeof CHANNELS)[number];

/** Whether the lead has the contact detail the chosen channel needs. */
function supportsChannel(lead: Lead, channel: OutreachChannel): boolean {
  return channel === "email" ? Boolean(lead.email) : Boolean(lead.phone);
}

/** Delivers one lead to the n8n outreach webhook. The channel field tells the
 * workflow which branch to run; without it n8n defaults to a call. */
async function deliverLead(webhookUrl: string, lead: Lead, channel: OutreachChannel): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...lead, channel }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`The outreach webhook responded with ${response.status}`);
}

export async function POST(request: Request) {
  try {
    const webhookUrl = process.env.N8N_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      return NextResponse.json(
        { error: "N8N_WEBHOOK_URL is not set in .env, so there is no outreach webhook to call." },
        { status: 400 },
      );
    }

    const body = (await request.json()) as { leadKey?: unknown; all?: unknown; channel?: unknown };

    const channel = String(body.channel ?? "call").trim().toLowerCase() as OutreachChannel;
    if (!CHANNELS.includes(channel)) {
      return NextResponse.json(
        { error: `channel must be one of: ${CHANNELS.join(", ")}` },
        { status: 400 },
      );
    }

    const leads = await readLeads();

    let targets: Lead[];
    if (body.all === true) {
      targets = leads.filter((lead) => leadKeyForClient(lead) && supportsChannel(lead, channel));
      if (!targets.length) {
        return NextResponse.json(
          { error: `No leads have the contact details needed for a ${channel}.` },
          { status: 400 },
        );
      }
    } else if (typeof body.leadKey === "string" && body.leadKey.trim()) {
      const key = body.leadKey.trim().toLowerCase();
      targets = leads.filter((lead) => leadKeyForClient(lead) === key);
      if (!targets.length) {
        return NextResponse.json({ error: "No saved lead matches that email/phone." }, { status: 404 });
      }
      targets = targets.filter((lead) => supportsChannel(lead, channel));
      if (!targets.length) {
        return NextResponse.json(
          {
            error:
              channel === "email"
                ? "This lead has no email address, so an email cannot be sent."
                : "This lead has no phone number, so a call/WhatsApp cannot be made.",
          },
          { status: 400 },
        );
      }
    } else {
      return NextResponse.json(
        { error: "Pass a leadKey (the lead's email or phone) or all: true." },
        { status: 400 },
      );
    }

    await ensureDataDirectory();
    let sent = 0;
    const failed: string[] = [];
    for (const lead of targets) {
      const label = lead.business_name || lead.website || "lead";
      try {
        await deliverLead(webhookUrl, lead, channel);
        sent += 1;
        await appendActivityEvent({
          id: crypto.randomUUID(),
          type: "outreach_sent",
          message: `Sent ${label} to outreach via ${channel}`,
          detail: "Triggered manually from the dashboard",
          createdAt: new Date().toISOString(),
        });
      } catch {
        failed.push(label);
      }
    }

    if (!sent) {
      return NextResponse.json(
        { error: `Could not reach the outreach webhook for: ${failed.join(", ")}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ sent, failed, channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not send to outreach";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
