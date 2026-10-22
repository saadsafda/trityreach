import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, writeTextAtomic } from "@/lib/storage";
import type { ErpNextStatus, Lead } from "@/lib/types";

/** Server-only ERPNext (Frappe) integration: connection config, REST calls,
 * and the duplicate index used to skip leads that already exist in the ERP.
 *
 * The duplicate-matching rules here are mirrored in scrape_leads.py
 * (ErpNextSync) — keep the two in step, or the scraper and the CRM "Sync"
 * button will disagree about what counts as "already in ERPNext". */

export const ERPNEXT_CONFIG_PATH = path.join(DATA_DIR, "erpnext.json");

export type ErpNextConfig = {
  url: string;
  apiKey: string;
  apiSecret: string;
  saveLeads: boolean;
  skipExisting: boolean;
  user: string;
  connectedAt: string;
};

export const DISCONNECTED_STATUS: ErpNextStatus = {
  connected: false,
  url: "",
  apiKeyHint: "",
  user: "",
  saveLeads: true,
  skipExisting: true,
  connectedAt: "",
};

/** Accepts what people paste from the address bar ("erp.acme.com/app/lead")
 * and reduces it to the site origin the REST API lives under. */
export function normalizeErpUrl(value: string): string {
  let raw = value.trim();
  if (!raw) throw new Error("Enter your ERP site URL.");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("The ERP URL does not look valid.");
  }
  return parsed.origin;
}

export async function readErpConfig(): Promise<ErpNextConfig | null> {
  try {
    const raw = JSON.parse(await fs.readFile(ERPNEXT_CONFIG_PATH, "utf8")) as Partial<ErpNextConfig>;
    if (!raw.url || !raw.apiKey || !raw.apiSecret) return null;
    return {
      url: raw.url,
      apiKey: raw.apiKey,
      apiSecret: raw.apiSecret,
      saveLeads: raw.saveLeads !== false,
      skipExisting: raw.skipExisting !== false,
      user: raw.user ?? "",
      connectedAt: raw.connectedAt ?? "",
    };
  } catch {
    return null;
  }
}

export async function writeErpConfig(config: ErpNextConfig): Promise<void> {
  await writeTextAtomic(ERPNEXT_CONFIG_PATH, JSON.stringify(config, null, 2));
  // The file holds an API secret; keep it readable by this user only.
  await fs.chmod(ERPNEXT_CONFIG_PATH, 0o600).catch(() => undefined);
}

export async function clearErpConfig(): Promise<void> {
  await fs.rm(ERPNEXT_CONFIG_PATH, { force: true });
}

export function toPublicStatus(config: ErpNextConfig | null): ErpNextStatus {
  if (!config) return DISCONNECTED_STATUS;
  return {
    connected: true,
    url: config.url,
    apiKeyHint: `••••${config.apiKey.slice(-4)}`,
    user: config.user,
    saveLeads: config.saveLeads,
    skipExisting: config.skipExisting,
    connectedAt: config.connectedAt,
  };
}

export async function readErpStatus(): Promise<ErpNextStatus> {
  return toPublicStatus(await readErpConfig());
}

/** Env vars the spawned scraper reads. Always set (empty when disconnected) so
 * a stale ERPNEXT_* line in .env can't re-enable a dashboard-disconnected ERP. */
export function erpEnvFor(config: ErpNextConfig | null): Record<string, string> {
  return {
    ERPNEXT_URL: config?.url ?? "",
    ERPNEXT_API_KEY: config?.apiKey ?? "",
    ERPNEXT_API_SECRET: config?.apiSecret ?? "",
    ERPNEXT_SAVE_LEADS: config?.saveLeads ? "1" : "0",
    ERPNEXT_SKIP_EXISTING: config?.skipExisting ? "1" : "0",
  };
}

type Credentials = Pick<ErpNextConfig, "url" | "apiKey" | "apiSecret">;

/** Pulls the human-readable reason out of a Frappe error body, which may be in
 * `_server_messages` (a JSON string of JSON strings), `exception`, or `message`. */
function frappeErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record._server_messages === "string") {
      try {
        const messages = (JSON.parse(record._server_messages) as string[]).map((item) => {
          try {
            return String((JSON.parse(item) as { message?: string }).message ?? item);
          } catch {
            return item;
          }
        });
        const text = messages.join(" ").replace(/<[^>]+>/g, "").trim();
        if (text) return text;
      } catch {
        // fall through
      }
    }
    if (typeof record.exception === "string") return record.exception.split("\n")[0];
    if (typeof record.message === "string") return record.message;
  }
  if (status === 401 || status === 403) return "ERP rejected the API key/secret, or this user lacks permission.";
  if (status === 404) return "Not found on this ERP site.";
  return `ERP responded with HTTP ${status}.`;
}

async function erpRequest<T>(creds: Credentials, pathname: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${creds.url}${pathname}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `token ${creds.apiKey}:${creds.apiSecret}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach ERP at ${creds.url} (${reason}).`);
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    if (!response.ok) throw new Error(frappeErrorMessage(null, response.status));
    throw new Error("ERP returned a non-JSON response. Check the site URL.");
  }
  if (!response.ok) throw new Error(frappeErrorMessage(body, response.status));
  return body as T;
}

/** Verifies the credentials and that the site actually has the Lead doctype
 * readable by this user. Returns the ERPNext user id. */
export async function testErpConnection(creds: Credentials): Promise<string> {
  const who = await erpRequest<{ message?: string }>(creds, "/api/method/frappe.auth.get_logged_user");
  const user = String(who.message ?? "");
  if (!user || user === "Guest") throw new Error("ERP did not accept the API key/secret.");
  try {
    await erpRequest(creds, `/api/resource/Lead?limit_page_length=1`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Connected as ${user}, but could not read Leads: ${reason}`);
  }
  return user;
}

// ---------------------------------------------------------------------------
// Duplicate matching (mirrored in scrape_leads.py)

/** Hosts shared by many unrelated businesses, where only host + path
 * identifies one (facebook.com/joespizza, yelp.com/biz/joes-pizza). */
const SHARED_HOSTS = new Set([
  "facebook.com",
  "m.facebook.com",
  "instagram.com",
  "linkedin.com",
  "linktr.ee",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  "google.com",
  "sites.google.com",
  "business.site",
  "yelp.com",
]);

export function emailKey(value: string): string {
  const email = value.trim().toLowerCase();
  return email.includes("@") ? email : "";
}

/** Last 10 digits, so "+44 20 7946 0958" and "020 7946 0958" collide. */
export function phoneKey(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7) return "";
  return digits.slice(-10);
}

export function websiteKey(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return "";
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host.includes(".")) return "";
  if (SHARED_HOSTS.has(host)) {
    const page = parsed.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    return page ? `${host}/${page}` : "";
  }
  return host;
}

export function nameKey(value: string): string {
  const key = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return key.length >= 4 ? key : "";
}

function cityKey(value: string): string {
  return value.trim().toLowerCase();
}

export type ExistingIndex = {
  emails: Set<string>;
  phones: Set<string>;
  websites: Set<string>;
  /** name key → cities it was seen in ("" = unknown city). */
  names: Map<string, Set<string>>;
  size: number;
};

function emptyIndex(): ExistingIndex {
  return { emails: new Set(), phones: new Set(), websites: new Set(), names: new Map(), size: 0 };
}

function addToIndex(
  index: ExistingIndex,
  record: { names: string[]; emails: string[]; phones: string[]; website: string; city: string },
) {
  for (const email of record.emails) if (emailKey(email)) index.emails.add(emailKey(email));
  for (const phone of record.phones) if (phoneKey(phone)) index.phones.add(phoneKey(phone));
  if (websiteKey(record.website)) index.websites.add(websiteKey(record.website));
  for (const name of record.names) {
    const key = nameKey(name);
    if (!key) continue;
    const cities = index.names.get(key) ?? new Set<string>();
    cities.add(cityKey(record.city));
    index.names.set(key, cities);
  }
  index.size += 1;
}

/** Why `lead` counts as already in ERPNext, or "" if it is new. A business
 * name only matches when the cities agree (or either city is unknown), so a
 * chain's branch in another city still comes through. */
export function existingMatch(index: ExistingIndex, lead: Lead): string {
  const email = emailKey(lead.email);
  if (email && index.emails.has(email)) return `email ${lead.email}`;
  const phone = phoneKey(lead.phone);
  if (phone && index.phones.has(phone)) return `phone ${lead.phone}`;
  const site = websiteKey(lead.website);
  if (site && index.websites.has(site)) return `website ${site}`;
  const name = nameKey(lead.business_name);
  const cities = name ? index.names.get(name) : undefined;
  if (cities) {
    const city = cityKey(lead.city);
    if (!city || cities.has("") || cities.has(city)) return `name ${lead.business_name}`;
  }
  return "";
}

/** Adds a just-created lead so later rows in the same batch dedupe against it. */
export function rememberLead(index: ExistingIndex, lead: Lead) {
  addToIndex(index, {
    names: [lead.business_name],
    emails: [lead.email],
    phones: [lead.phone],
    website: lead.website,
    city: lead.city,
  });
}

type ResourceList = { data?: Record<string, unknown>[] };

/** Loads every Lead (and, when the user may read them, every Customer) into
 * an index of normalized emails, phones, websites, and names. */
export async function fetchExistingIndex(creds: Credentials): Promise<ExistingIndex> {
  const index = emptyIndex();
  const str = (value: unknown) => (typeof value === "string" ? value : "");

  const leadFields = JSON.stringify(["lead_name", "company_name", "email_id", "mobile_no", "phone", "website", "city"]);
  const leads = await erpRequest<ResourceList>(
    creds,
    `/api/resource/Lead?fields=${encodeURIComponent(leadFields)}&limit_page_length=0`,
  );
  for (const row of leads.data ?? []) {
    addToIndex(index, {
      names: [str(row.company_name), str(row.lead_name)],
      emails: [str(row.email_id)],
      phones: [str(row.mobile_no), str(row.phone)],
      website: str(row.website),
      city: str(row.city),
    });
  }

  // Existing customers are just as much "already known" as leads. Not every
  // API user can read Customer, so this part is best-effort.
  try {
    const customerFields = JSON.stringify(["customer_name", "email_id", "mobile_no", "website"]);
    const customers = await erpRequest<ResourceList>(
      creds,
      `/api/resource/Customer?fields=${encodeURIComponent(customerFields)}&limit_page_length=0`,
    );
    for (const row of customers.data ?? []) {
      addToIndex(index, {
        names: [str(row.customer_name)],
        emails: [str(row.email_id)],
        phones: [str(row.mobile_no)],
        website: str(row.website),
        city: "",
      });
    }
  } catch {
    // Leads-only dedupe is still useful.
  }
  return index;
}

/** Maps a TrityReach lead onto ERPNext's Lead doctype. Unknown fields are
 * ignored by Frappe, so this works on v13–v15. */
export function toErpLeadDoc(lead: Lead): Record<string, string> {
  const person = lead.contact_name.trim();
  // first_name only when there's a real person: ERPNext v14+ rebuilds
  // lead_name from it, and with none it falls back to company_name.
  const [firstName = "", ...rest] = person ? person.split(/\s+/) : [];
  const doc: Record<string, string> = {
    lead_name: person || lead.business_name,
    first_name: firstName,
    last_name: rest.join(" "),
    company_name: lead.business_name,
    email_id: lead.email,
    mobile_no: lead.phone,
    phone: lead.phone,
    website: lead.website,
    city: lead.city,
    // Filled on sites with a custom "Address" field on Lead; ignored elsewhere.
    custom_address: lead.address,
  };
  return Object.fromEntries(Object.entries(doc).filter(([, value]) => value.trim()));
}

/** Store type + address as an HTML note (ERPNext v14+ "CRM Note" child table);
 * the Lead doctype has no street-address field. Mirrors _lead_note_html. */
function leadNote(lead: Lead): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const lines = (
    [
      ["Store type", lead.store_type],
      ["Address", lead.address],
      ["Found by", "TrityReach lead finder"],
    ] as const
  ).filter(([, value]) => value?.trim());
  if (lines.length <= 1) return "";
  return lines.map(([label, value]) => `<b>${label}:</b> ${escape(value)}`).join("<br>");
}

/** Creates the lead in ERPNext and returns its document name (e.g. CRM-LEAD-2026-00042). */
export async function createErpLead(creds: Credentials, lead: Lead): Promise<string> {
  const doc: Record<string, unknown> = toErpLeadDoc(lead);
  const note = leadNote(lead);
  const post = (body: Record<string, unknown>) =>
    erpRequest<{ data?: { name?: string } }>(creds, "/api/resource/Lead", { method: "POST", body: JSON.stringify(body) });
  let result: { data?: { name?: string } };
  if (note) {
    try {
      result = await post({ ...doc, notes: [{ note }] });
    } catch {
      // Older ERPNext (v13) has a plain-text notes field: retry without.
      result = await post(doc);
    }
  } else {
    result = await post(doc);
  }
  return String(result.data?.name ?? "");
}

// ---------------------------------------------------------------------------
// Lead map: every ERPNext Lead with whatever location it carries

export type ErpMapLead = {
  name: string;
  business_name: string;
  contact_name: string;
  email: string;
  phone: string;
  website: string;
  city: string;
  state: string;
  country: string;
  store_type: string;
  address: string;
  lat: string;
  lng: string;
  createdAt: string;
};

/** Pull "Store type:", "Address:" and the Map link's coordinates back out of
 * the note TrityReach writes on each Lead (see _lead_note_html). */
function parseLeadNote(html: string): { store_type: string; address: string; lat: string; lng: string } {
  const coords = html.match(/query=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const field = (label: string) => text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "mi"))?.[1].trim() ?? "";
  return { store_type: field("Store type"), address: field("Address"), lat: coords?.[1] ?? "", lng: coords?.[2] ?? "" };
}

/** A free-text address is only geocoded when it pins down a place (ZIP code
 * or state): "1100 SW 141 AVE" alone would land on a random street. */
function usableAddress(value: string): string {
  const address = value.replace(/\s+/g, " ").trim().replace(/[.,]+$/, "");
  if (address.length < 8) return "";
  return /\b\d{5}(?:-\d{4})?\b/.test(address) || /,\s*[A-Z]{2}\b/.test(address) || /\b[A-Z]{2}\s+\d{5}\b/.test(address)
    ? address
    : "";
}

export async function fetchErpLeadsForMap(creds: Credentials): Promise<ErpMapLead[]> {
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const baseFields = [
    "name", "company_name", "lead_name", "first_name", "email_id", "mobile_no", "phone",
    "website", "city", "state", "country", "creation",
  ];
  const listLeads = (fields: string[]) =>
    erpRequest<ResourceList>(
      creds,
      `/api/resource/Lead?fields=${encodeURIComponent(JSON.stringify(fields))}&limit_page_length=0&order_by=${encodeURIComponent("creation desc")}`,
    );
  let leads: ResourceList;
  try {
    // Some sites add a custom "Address" text field to Lead; use it when present.
    leads = await listLeads([...baseFields, "custom_address"]);
  } catch {
    leads = await listLeads(baseFields);
  }

  // All Lead notes in one request (child table listed through its parent).
  const notesByLead = new Map<string, string>();
  try {
    const noteFields = JSON.stringify(["parent", "note"]);
    const filters = JSON.stringify([["parenttype", "=", "Lead"]]);
    const notes = await erpRequest<ResourceList>(
      creds,
      `/api/resource/CRM%20Note?fields=${encodeURIComponent(noteFields)}&filters=${encodeURIComponent(filters)}&parent=Lead&limit_page_length=0`,
    );
    for (const row of notes.data ?? []) {
      const parent = str(row.parent);
      notesByLead.set(parent, `${notesByLead.get(parent) ?? ""}<br>${str(row.note)}`);
    }
  } catch {
    // ERPNext v13 has no CRM Note table; city-level pins still work.
  }

  return (leads.data ?? []).map((row) => {
    const note = parseLeadNote(notesByLead.get(str(row.name)) ?? "");
    const company = str(row.company_name);
    const person = str(row.lead_name);
    return {
      name: str(row.name),
      business_name: company || person,
      contact_name: company && person !== company ? person : "",
      email: str(row.email_id),
      phone: str(row.mobile_no) || str(row.phone),
      website: str(row.website),
      city: str(row.city),
      state: str(row.state),
      country: str(row.country),
      store_type: note.store_type,
      address: note.address || usableAddress(str(row.custom_address)),
      lat: note.lat,
      lng: note.lng,
      createdAt: str(row.creation),
    };
  });
}
