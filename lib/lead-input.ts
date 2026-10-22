import { LEAD_FIELDS, type Lead } from "@/lib/types";

/** Clean and check one lead from a form or an uploaded file. Same rules for
 * both: a business name, plus an email or phone that looks real. */
export function validateLead(input: Record<string, unknown>): { lead: Lead } | { error: string } {
  const lead = Object.fromEntries(
    LEAD_FIELDS.map((field) => [field, String(input[field] ?? "").replace(/\s+/g, " ").trim().slice(0, 300)]),
  ) as Lead;

  if (!lead.business_name) return { error: "Business name is required." };
  if (!lead.email && !lead.phone) return { error: "Add an email or a phone number so the lead can be contacted." };
  if (lead.email && !/^\S+@\S+\.\S+$/.test(lead.email)) return { error: "The email address does not look valid." };
  if (lead.phone && lead.phone.replace(/\D/g, "").length < 7) return { error: "The phone number does not look valid." };
  if (lead.website && !/^https?:\/\//i.test(lead.website)) lead.website = `https://${lead.website}`;
  // Coordinates only when both are real numbers in range.
  const lat = Number(lead.lat);
  const lng = Number(lead.lng);
  if (!lead.lat || !lead.lng || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    lead.lat = "";
    lead.lng = "";
  }
  return { lead };
}
