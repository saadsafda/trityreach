export const LEAD_FIELDS = [
  "business_name",
  "contact_name",
  "email",
  "phone",
  "website",
  "city",
  "address",
] as const;

export type LeadField = (typeof LEAD_FIELDS)[number];

export type Lead = Record<LeadField, string>;

export type JobState =
  | "idle"
  | "queued"
  | "discovering"
  | "running"
  | "enriching"
  | "completed"
  | "failed";

export type JobStatus = {
  jobId: string;
  status: JobState;
  currentUrl: string;
  completed: number;
  total: number;
  message: string;
  error: string;
  query: string;
  discoveredUrls: string[];
  pid?: number;
  updatedAt: string;
};

export type SearchPreferences = {
  query: string;
  limit: number;
};

export type DashboardState = {
  search: SearchPreferences;
  leads: Lead[];
  status: JobStatus;
};

/** Outreach channel a message was sent or received on. */
export type ConversationChannel = "email" | "whatsapp" | "call" | "crm";

export type ConversationDirection = "outbound" | "inbound";

/**
 * One logged message/event for a lead's outreach thread. Written by the n8n
 * workflow via POST /api/conversations immediately after it sends (or
 * receives) something on a lead's behalf.
 */
export type ConversationEntry = {
  id: string;
  /** Identifies the lead this entry belongs to: the lead's email, or if no
   * email, its phone number. Matches Lead.email / Lead.phone. */
  leadKey: string;
  channel: ConversationChannel;
  direction: ConversationDirection;
  /** Short label, e.g. an email subject or call outcome. */
  subject?: string;
  content: string;
  status?: string;
  createdAt: string;
};

/** A single row in the live activity feed on the workflow dashboard. */
export type ActivityEventType =
  | "discovering"
  | "scraping"
  | "enriching"
  | "lead_found"
  | "webhook_sent"
  | "outreach_sent"
  | "completed"
  | "failed";

export type ActivityEvent = {
  id: string;
  type: ActivityEventType;
  message: string;
  detail?: string;
  createdAt: string;
};
