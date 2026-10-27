export const LEAD_FIELDS = [
  "business_name",
  "contact_name",
  "email",
  "phone",
  "website",
  "city",
  "address",
  /** Store Finder category, e.g. "Dollar store" (blank for web/maps leads). */
  "store_type",
  /** Map position from Google Maps, when known (strings, like every CSV field). */
  "lat",
  "lng",
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
  /** Why a finished run came up short of its target, if it did. */
  notice?: string;
  pid?: number;
  updatedAt: string;
};

export type LeadSource = "web" | "maps" | "stores";

export type SearchPreferences = {
  query: string;
  limit: number;
  source: LeadSource;
  /** Store Finder: category keys (lib/store-types.ts). */
  storeTypes: string[];
  /** Store Finder: places to search, e.g. "Edison, NJ". */
  locations: string[];
  /** Store Finder: miles around each ZIP-code location (0 = only inside the ZIP). */
  zipRadius: number;
  /** Send new leads to the n8n outreach webhook (real AI calls) right after a run. */
  autoOutreach: boolean;
};

/** What the browser is allowed to see about the ERPNext connection — never
 * the API secret. */
export type ErpNextStatus = {
  connected: boolean;
  url: string;
  /** API key with all but the last 4 characters masked. */
  apiKeyHint: string;
  /** The ERPNext user the API key belongs to, from the last connection test. */
  user: string;
  /** Create each new scraped lead as an ERPNext Lead. */
  saveLeads: boolean;
  /** Drop scraped leads whose email/phone/website/name already exist in ERPNext. */
  skipExisting: boolean;
  connectedAt: string;
};

export type DashboardState = {
  search: SearchPreferences;
  leads: Lead[];
  status: JobStatus;
  erpnext: ErpNextStatus;
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
  | "erpnext"
  | "completed"
  | "failed";

export type ActivityEvent = {
  id: string;
  type: ActivityEventType;
  message: string;
  detail?: string;
  createdAt: string;
};

/** One pin on the lead map. */
export type MapPoint = {
  id: string;
  business_name: string;
  contact_name: string;
  email: string;
  phone: string;
  website: string;
  city: string;
  address: string;
  store_type: string;
  lat: number;
  lng: number;
  /** Placed at the city centre because no street address is known. */
  approximate: boolean;
  /** Found by the latest scrape (leads.csv) — the "latest leads". */
  inRun: boolean;
  /** Added by hand on the CRM page (and not part of the latest run). */
  manual: boolean;
  /** ERPNext Lead name (e.g. CRM-LEAD-2026-00213) when it's in the ERP. */
  erpName: string;
  /** When the lead was created in ERPNext (ISO), if known. */
  createdAt: string;
};

export type MapState = {
  points: MapPoint[];
  /** Leads with no address or city at all — can't be placed. */
  unplaceable: number;
  /** Addresses still waiting to be geocoded (cached once done). */
  geocodePending: number;
  erp: { connected: boolean; count: number; error: string };
  /** The search that produced the latest leads, and when it last updated. */
  latestRun: { query: string; at: string; status: string };
};

/** Result of importing an uploaded lead file (POST /api/leads/import). */
export type ImportSummary = {
  imported: number;
  duplicatesInFile: number;
  alreadyInCrm: number;
  alreadyInErp: number;
  /** First 50 rows that failed validation, with the spreadsheet row number. */
  invalid: { row: number; business: string; reason: string }[];
  invalidCount: number;
  /** Set when ERP couldn't be reached, so its duplicate check was skipped. */
  erpWarning?: string;
};
