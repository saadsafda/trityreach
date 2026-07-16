import type { Lead } from "@/lib/types";

/** Identity key linking a Lead to its ConversationEntry rows: email if
 * present, otherwise phone. Must match how n8n keys entries it posts back.
 * A pure function with no Node dependency, so both client components and
 * lib/storage.ts (which re-exports it as leadKeyFor) can import it. */
export function leadKeyForClient(lead: Pick<Lead, "email" | "phone">): string {
  return (lead.email || lead.phone || "").trim().toLowerCase();
}
