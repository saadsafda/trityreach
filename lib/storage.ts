import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { listSavedLeads, queryLeadPage, saveLeads, withSavedRecords, type LeadPageQuery } from "@/lib/lead-db";
import { leadKeyForClient } from "@/lib/lead-key";
import { DEFAULT_STORE_TYPES } from "@/lib/store-types";
import {
  ActivityEvent,
  DashboardState,
  JobStatus,
  LEAD_FIELDS,
  Lead,
  LeadPage,
  ConversationEntry,
  SavedLead,
  SearchPreferences,
} from "@/lib/types";

export const ROOT_DIR = process.cwd();
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const URLS_PATH = path.join(ROOT_DIR, "urls.txt");
export const LEADS_PATH = path.join(ROOT_DIR, "leads.csv");
export const STATUS_PATH = path.join(DATA_DIR, "scrape-status.json");
export const LOG_PATH = path.join(DATA_DIR, "scrape.log");
export const SEARCH_CONFIG_PATH = path.join(DATA_DIR, "search-config.json");
export const CONVERSATIONS_PATH = path.join(DATA_DIR, "conversations.json");
export const ACTIVITY_PATH = path.join(DATA_DIR, "activity.json");
export const MANUAL_LEADS_PATH = path.join(DATA_DIR, "manual-leads.json");
/** Leads found while ERPNext was offline, waiting to be saved there
 * (written by scrape_leads.py, cleared as ERP takes them). */
export const PENDING_ERP_PATH = path.join(DATA_DIR, "erp-pending.json");

const MAX_CONVERSATION_ENTRIES = 2000;
const MAX_ACTIVITY_EVENTS = 500;

export const IDLE_STATUS: JobStatus = {
  jobId: "",
  status: "idle",
  currentUrl: "",
  completed: 0,
  total: 0,
  message: "Ready to scrape",
  error: "",
  query: "",
  discoveredUrls: [],
  updatedAt: "",
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Serializes read-modify-write append calls per file within this process,
 * so concurrent requests (e.g. several n8n branches posting at once) can't
 * race and drop each other's entries. Does not protect against a second
 * process writing the same file concurrently. */
const appendLocks = new Map<string, Promise<unknown>>();

async function withAppendLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = appendLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  appendLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (appendLocks.get(key) === run) appendLocks.delete(key);
  }
}

export async function ensureDataDirectory(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, value, "utf8");
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function readUrls(): Promise<string[]> {
  if (!(await exists(URLS_PATH))) return [];
  const value = await fs.readFile(URLS_PATH, "utf8");
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !line.startsWith("#"));
}

export async function writeUrls(urls: string[]): Promise<void> {
  await writeTextAtomic(URLS_PATH, `${urls.join("\n")}\n`);
}

/** Allowed "around each ZIP" radii in miles (0 = only inside the ZIP). */
export const ZIP_RADII = [0, 2, 5, 10, 25];

const DEFAULT_SEARCH: SearchPreferences = {
  query: "",
  limit: 25,
  source: "stores",
  storeTypes: [...DEFAULT_STORE_TYPES],
  locations: [],
  zipRadius: 5,
  autoOutreach: false,
};

export async function readSearchPreferences(): Promise<SearchPreferences> {
  if (!(await exists(SEARCH_CONFIG_PATH))) return DEFAULT_SEARCH;
  try {
    const value = JSON.parse(await fs.readFile(SEARCH_CONFIG_PATH, "utf8")) as Partial<SearchPreferences>;
    const source = value.source === "maps" || value.source === "web" || value.source === "stores" ? value.source : "stores";
    // Keys are checked against the live catalog (incl. custom types) by the
    // dashboard and the scrape route; here only the shape is validated.
    const storeTypes = Array.isArray(value.storeTypes)
      ? value.storeTypes.map(String).filter((key) => /^[a-z0-9_]{2,60}$/.test(key)).slice(0, 50)
      : [];
    return {
      query: typeof value.query === "string" ? value.query : "",
      limit: Math.min(source === "stores" ? 1000 : 25, Math.max(1, Number(value.limit) || 5)),
      source,
      storeTypes: storeTypes.length ? storeTypes : [...DEFAULT_STORE_TYPES],
      locations: Array.isArray(value.locations) ? value.locations.map(String).filter(Boolean).slice(0, 20) : [],
      zipRadius: ZIP_RADII.includes(Number(value.zipRadius)) ? Number(value.zipRadius) : 5,
      autoOutreach: value.autoOutreach === true,
    };
  } catch {
    return DEFAULT_SEARCH;
  }
}

export async function writeSearchPreferences(value: SearchPreferences): Promise<void> {
  await writeTextAtomic(SEARCH_CONFIG_PATH, JSON.stringify(value, null, 2));
}

export async function readScrapedLeads(): Promise<Lead[]> {
  if (!(await exists(LEADS_PATH))) return [];
  const csv = await fs.readFile(LEADS_PATH, "utf8");
  const records = parse(csv.replace(/^\uFEFF/, ""), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, unknown>[];

  return records
    .map(
      (record) =>
        Object.fromEntries(
          LEAD_FIELDS.map((field) => [field, String(record[field] ?? "")]),
        ) as Lead,
    )
    .filter((lead) => Object.values(lead).some((value) => value.trim()));
}

async function readLeadList(filePath: string): Promise<Lead[]> {
  if (!(await exists(filePath))) return [];
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!Array.isArray(raw)) return [];
    return (raw as Record<string, unknown>[]).map(
      (record) =>
        Object.fromEntries(
          LEAD_FIELDS.map((field) => [field, String(record[field] ?? "")]),
        ) as Lead,
    );
  } catch {
    return [];
  }
}

export async function readManualLeads(): Promise<Lead[]> {
  return readLeadList(MANUAL_LEADS_PATH);
}

export async function readPendingErpLeads(): Promise<Lead[]> {
  return readLeadList(PENDING_ERP_PATH);
}

/** Drop leads ERPNext now has from the waiting list. */
export async function removePendingErpLeads(isInErp: (lead: Lead) => boolean): Promise<void> {
  await withAppendLock(PENDING_ERP_PATH, async () => {
    const pending = await readPendingErpLeads();
    const remaining = pending.filter((lead) => !isInErp(lead));
    if (remaining.length !== pending.length) {
      await writeTextAtomic(PENDING_ERP_PATH, JSON.stringify(remaining, null, 2));
    }
  });
}

export async function appendManualLead(lead: Lead): Promise<void> {
  await withAppendLock(MANUAL_LEADS_PATH, async () => {
    const existing = await readManualLeads();
    existing.push(lead);
    await writeTextAtomic(MANUAL_LEADS_PATH, JSON.stringify(existing, null, 2));
  });
  saveLeads([lead], "manual");
}

/** Append many manual leads in one write (file uploads). */
export async function appendManualLeads(leads: Lead[]): Promise<void> {
  if (!leads.length) return;
  await withAppendLock(MANUAL_LEADS_PATH, async () => {
    const existing = await readManualLeads();
    await writeTextAtomic(MANUAL_LEADS_PATH, JSON.stringify([...existing, ...leads], null, 2));
  });
  saveLeads(leads, "import");
}

/** All leads the dashboard works with: scraped (leads.csv, rewritten by every
 * scrape), manually added ones (data/manual-leads.json, which scrapes never
 * touch), and earlier runs' leads still waiting for an offline ERPNext.
 * Deduplicated by email/phone key, scraped entries first. */
export async function readLeads(): Promise<Lead[]> {
  const [scraped, manual, pending] = await Promise.all([readScrapedLeads(), readManualLeads(), readPendingErpLeads()]);
  const seen = new Set<string>();
  const merged: Lead[] = [];
  for (const lead of [...scraped, ...manual, ...pending]) {
    const key = leadKeyForClient(lead);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    merged.push(lead);
  }
  return merged;
}

export async function readStatus(): Promise<JobStatus> {
  if (!(await exists(STATUS_PATH))) return IDLE_STATUS;
  try {
    const raw = JSON.parse(await fs.readFile(STATUS_PATH, "utf8")) as Partial<JobStatus>;
    return {
      ...IDLE_STATUS,
      ...raw,
      completed: Number(raw.completed ?? 0),
      total: Number(raw.total ?? 0),
    };
  } catch {
    return { ...IDLE_STATUS, status: "failed", error: "Could not read job status" };
  }
}

export async function writeStatus(status: JobStatus): Promise<void> {
  await writeTextAtomic(STATUS_PATH, JSON.stringify(status, null, 2));
}

/** Every lead in the CRM's database, newest first (the current working set is
 * saved first, in case it hasn't reached the database yet). */
export async function readSavedLeads(): Promise<SavedLead[]> {
  withSavedRecords(await readLeads());
  return listSavedLeads();
}

/** One page of the CRM's table. */
export async function readLeadPage(query: LeadPageQuery): Promise<LeadPage> {
  withSavedRecords(await readLeads());
  return queryLeadPage(query);
}

export function isProcessRunning(pid?: number): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Everything on the dashboard except the ERPNext status, which
 * app/api/state adds (lib/erpnext imports this module, so not the reverse). */
export async function readDashboardState(): Promise<Omit<DashboardState, "erpnext">> {
  const [search, leads, savedStatus] = await Promise.all([
    readSearchPreferences(),
    readLeads(),
    readStatus(),
  ]);
  let status = savedStatus;

  if (
    (status.status === "queued" ||
      status.status === "discovering" ||
      status.status === "running" ||
      status.status === "enriching") &&
    status.pid &&
    !isProcessRunning(status.pid)
  ) {
    status = {
      ...status,
      status: "failed",
      currentUrl: "",
      message: "The scraper process stopped unexpectedly",
      error: "The background process is no longer running.",
      updatedAt: new Date().toISOString(),
    };
    await writeStatus(status);
  }

  return { search, leads: withSavedRecords(leads), status };
}

export { leadKeyForClient as leadKeyFor } from "@/lib/lead-key";

export async function readConversations(): Promise<ConversationEntry[]> {
  if (!(await exists(CONVERSATIONS_PATH))) return [];
  try {
    const raw = JSON.parse(await fs.readFile(CONVERSATIONS_PATH, "utf8"));
    return Array.isArray(raw) ? (raw as ConversationEntry[]) : [];
  } catch {
    return [];
  }
}

export async function appendConversationEntry(
  entry: ConversationEntry,
): Promise<void> {
  await withAppendLock(CONVERSATIONS_PATH, async () => {
    const existing = await readConversations();
    const next = [...existing, entry].slice(-MAX_CONVERSATION_ENTRIES);
    await writeTextAtomic(CONVERSATIONS_PATH, JSON.stringify(next, null, 2));
  });
}

export async function readActivity(): Promise<ActivityEvent[]> {
  if (!(await exists(ACTIVITY_PATH))) return [];
  try {
    const raw = JSON.parse(await fs.readFile(ACTIVITY_PATH, "utf8"));
    return Array.isArray(raw) ? (raw as ActivityEvent[]) : [];
  } catch {
    return [];
  }
}

export async function appendActivityEvent(event: ActivityEvent): Promise<void> {
  await withAppendLock(ACTIVITY_PATH, async () => {
    const existing = await readActivity();
    const next = [...existing, event].slice(-MAX_ACTIVITY_EVENTS);
    await writeTextAtomic(ACTIVITY_PATH, JSON.stringify(next, null, 2));
  });
}
