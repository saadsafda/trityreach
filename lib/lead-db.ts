import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LEAD_FIELDS, type Lead, type LeadNote, type LeadOrigin, type LeadPage, type SavedLead } from "@/lib/types";

/** Every lead ever found or added, and the notes on them (SQLite, in
 * data/leads.db). leads.csv only holds the latest run, so this is what the CRM
 * lists. scrape_leads.py writes here too (save_leads_to_db): keep the schema
 * and leadKeys() in step with it. */

const DB_PATH = path.join(process.cwd(), "data", "leads.db");
const NOTE_MAX_LENGTH = 4000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL DEFAULT '',
    contact_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    store_type TEXT NOT NULL DEFAULT '',
    lat TEXT NOT NULL DEFAULT '',
    lng TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'search',
    email_key TEXT NOT NULL DEFAULT '',
    phone_key TEXT NOT NULL DEFAULT '',
    other_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_email_key ON leads (email_key);
CREATE INDEX IF NOT EXISTS leads_phone_key ON leads (phone_key);
CREATE INDEX IF NOT EXISTS leads_other_key ON leads (other_key);
CREATE TABLE IF NOT EXISTS lead_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads (id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_notes_lead ON lead_notes (lead_id);
`;

function withDb<T>(task: (db: DatabaseSync) => T): T {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  try {
    // The scraper may be writing at the same moment.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    return task(db);
  } finally {
    db.close();
  }
}

type LeadKeys = { email: string; phone: string; other: string };

/** Which saved lead a lead is. Email and phone digits identify it; one with
 * neither only matches another with neither (by website, else name + city),
 * because branches of a business often share one website. */
function leadKeys(lead: Lead): LeadKeys {
  const email = lead.email.trim().toLowerCase();
  const digits = lead.phone.replace(/\D/g, "").slice(-10);
  const phone = digits.length >= 7 ? digits : "";
  if (email || phone) return { email, phone, other: "" };
  const website = lead.website
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
  const name = lead.business_name.trim().toLowerCase();
  return { email, phone, other: website || (name ? `${name}|${lead.city.trim().toLowerCase()}` : "") };
}

function toLead(row: Record<string, unknown>): Lead {
  return Object.fromEntries(LEAD_FIELDS.map((field) => [field, String(row[field] ?? "")])) as Lead;
}

function findLeadRow(db: DatabaseSync, keys: LeadKeys): Record<string, unknown> | undefined {
  const by = (column: string, value: string) =>
    value
      ? (db.prepare(`SELECT * FROM leads WHERE ${column} = ? ORDER BY id LIMIT 1`).get(value) as Record<string, unknown> | undefined)
      : undefined;
  return by("email_key", keys.email) ?? by("phone_key", keys.phone) ?? by("other_key", keys.other);
}

/** Add leads, or fill the blanks of ones already saved (never overwriting
 * what's there). `createdAt` keeps a lead's real age when importing one. */
export function saveLeads(
  leads: (Lead & { createdAt?: string })[],
  origin: LeadOrigin,
): { added: number; updated: number } {
  return withDb((db) => {
    let added = 0;
    let updated = 0;
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const lead of leads) {
        const keys = leadKeys(lead);
        if (!keys.email && !keys.phone && !keys.other) continue;
        const existing = findLeadRow(db, keys);
        if (!existing) {
          const created = lead.createdAt ? new Date(lead.createdAt) : null;
          const createdAt = created && !Number.isNaN(created.getTime()) ? created.toISOString() : now;
          db.prepare(
            `INSERT INTO leads (${LEAD_FIELDS.join(", ")}, origin, email_key, phone_key, other_key, created_at, updated_at)
             VALUES (${LEAD_FIELDS.map(() => "?").join(", ")}, ?, ?, ?, ?, ?, ?)`,
          ).run(...LEAD_FIELDS.map((field) => lead[field] ?? ""), origin, keys.email, keys.phone, keys.other, createdAt, now);
          added += 1;
          continue;
        }
        const current = toLead(existing);
        const merged = Object.fromEntries(
          LEAD_FIELDS.map((field) => [field, current[field].trim() ? current[field] : (lead[field] ?? "")]),
        ) as Lead;
        if (LEAD_FIELDS.every((field) => merged[field] === current[field])) continue;
        const mergedKeys = leadKeys(merged);
        db.prepare(
          `UPDATE leads SET ${LEAD_FIELDS.map((field) => `${field} = ?`).join(", ")},
             email_key = ?, phone_key = ?, other_key = ?, updated_at = ? WHERE id = ?`,
        ).run(
          ...LEAD_FIELDS.map((field) => merged[field]),
          mergedKeys.email,
          mergedKeys.phone,
          mergedKeys.other,
          now,
          Number(existing.id),
        );
        updated += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { added, updated };
  });
}

const SAVED_LEAD_COLUMNS = `l.*,
  (SELECT COUNT(*) FROM lead_notes n WHERE n.lead_id = l.id) AS note_count,
  (SELECT n.body FROM lead_notes n WHERE n.lead_id = l.id ORDER BY n.id DESC LIMIT 1) AS latest_note`;

function toSavedLead(row: Record<string, unknown>): SavedLead {
  return {
    ...toLead(row),
    id: Number(row.id),
    origin: String(row.origin) as LeadOrigin,
    savedAt: String(row.created_at),
    noteCount: Number(row.note_count),
    latestNote: String(row.latest_note ?? ""),
  };
}

/** Every saved lead, newest first. */
export function listSavedLeads(): SavedLead[] {
  return withDb((db) =>
    (
      db.prepare(`SELECT ${SAVED_LEAD_COLUMNS} FROM leads l ORDER BY l.created_at DESC, l.id DESC`).all() as Record<string, unknown>[]
    ).map(toSavedLead),
  );
}

export type LeadPageQuery = {
  page: number;
  pageSize: number;
  /** Matches any lead field or note; a phone number matches by its digits too. */
  search?: string;
  storeType?: string;
  /** Limit to leads with one of these conversation keys (see leadKeyForClient). */
  onlyKeys?: string[];
  /** Leave out leads with one of these conversation keys. */
  exceptKeys?: string[];
};

/** One page of saved leads, newest first. A page past the end gives the last page. */
export function queryLeadPage(query: LeadPageQuery): LeadPage {
  // SQL form of leadKeyForClient: email if present, otherwise phone.
  const leadKey = "lower(trim(CASE WHEN l.email <> '' THEN l.email ELSE l.phone END))";
  const where: string[] = [];
  const params: string[] = [];

  const search = query.search?.trim();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const columns = ["business_name", "contact_name", "email", "phone", "website", "city", "address", "store_type"];
    const matches = columns.map((column) => `l.${column} LIKE ? ESCAPE '\\'`);
    params.push(...columns.map(() => like));
    matches.push(`EXISTS (SELECT 1 FROM lead_notes n WHERE n.lead_id = l.id AND n.body LIKE ? ESCAPE '\\')`);
    params.push(like);
    // Typed like a phone number: match its digits, however the lead's is written.
    const digits = /^[\d\s()+.-]+$/.test(search) ? search.replace(/\D/g, "") : "";
    if (digits.length >= 3) {
      matches.push("l.phone_key LIKE ?");
      params.push(`%${digits}%`);
    }
    where.push(`(${matches.join(" OR ")})`);
  }
  if (query.storeType) {
    where.push("l.store_type = ?");
    params.push(query.storeType);
  }
  if (query.onlyKeys) {
    where.push(query.onlyKeys.length ? `${leadKey} IN (${query.onlyKeys.map(() => "?").join(", ")})` : "0");
    params.push(...query.onlyKeys);
  }
  if (query.exceptKeys?.length) {
    where.push(`${leadKey} NOT IN (${query.exceptKeys.map(() => "?").join(", ")})`);
    params.push(...query.exceptKeys);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  return withDb((db) => {
    const count = (sql: string, ...values: string[]) => Number((db.prepare(sql).get(...values) as { n: number }).n);
    const total = count(`SELECT COUNT(*) AS n FROM leads l ${whereSql}`, ...params);
    const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(Math.max(1, query.page), pageCount);
    const rows = db
      .prepare(`SELECT ${SAVED_LEAD_COLUMNS} FROM leads l ${whereSql} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (page - 1) * query.pageSize) as Record<string, unknown>[];
    const storeTypes = db
      .prepare("SELECT DISTINCT store_type FROM leads WHERE store_type <> '' ORDER BY store_type")
      .all() as { store_type: string }[];
    return {
      leads: rows.map(toSavedLead),
      total,
      allTotal: count("SELECT COUNT(*) AS n FROM leads"),
      page,
      pageSize: query.pageSize,
      pageCount,
      storeTypes: storeTypes.map((row) => row.store_type),
    };
  });
}

/** The saved record behind each of these leads, so they carry an id and notes.
 * Any not saved yet are saved first. A lead with nothing to identify it gets
 * id 0, which the pages treat as "can't take notes". */
export function withSavedRecords(leads: Lead[]): SavedLead[] {
  const match = (saved: SavedLead[]) => {
    const byKey = new Map<string, SavedLead>();
    for (const record of [...saved].reverse()) {
      const keys = leadKeys(record);
      if (keys.other) byKey.set(`o:${keys.other}`, record);
      if (keys.phone) byKey.set(`p:${keys.phone}`, record);
      if (keys.email) byKey.set(`e:${keys.email}`, record);
    }
    return (lead: Lead) => {
      const keys = leadKeys(lead);
      return (
        (keys.email && byKey.get(`e:${keys.email}`)) ||
        (keys.phone && byKey.get(`p:${keys.phone}`)) ||
        (keys.other && byKey.get(`o:${keys.other}`)) ||
        undefined
      );
    };
  };
  let find = match(listSavedLeads());
  const missing = leads.filter((lead) => !find(lead));
  if (missing.length) {
    saveLeads(missing, "search");
    find = match(listSavedLeads());
  }
  return leads.map((lead) => {
    const record = find(lead);
    return {
      ...lead,
      id: record?.id ?? 0,
      origin: record?.origin ?? "search",
      savedAt: record?.savedAt ?? "",
      noteCount: record?.noteCount ?? 0,
      latestNote: record?.latestNote ?? "",
    };
  });
}

function toNote(row: Record<string, unknown>): LeadNote {
  return { id: Number(row.id), leadId: Number(row.lead_id), body: String(row.body), createdAt: String(row.created_at) };
}

/** A lead's notes, newest first. */
export function listNotes(leadId: number): LeadNote[] {
  return withDb((db) =>
    (db.prepare("SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY id DESC").all(leadId) as Record<string, unknown>[]).map(toNote),
  );
}

export function addNote(leadId: number, text: string): LeadNote {
  const body = text.trim();
  if (!body) throw new Error("Write something in the note first.");
  if (body.length > NOTE_MAX_LENGTH) throw new Error(`Keep a note under ${NOTE_MAX_LENGTH} characters.`);
  return withDb((db) => {
    if (!db.prepare("SELECT id FROM leads WHERE id = ?").get(leadId)) throw new Error("That lead no longer exists.");
    const row = db
      .prepare("INSERT INTO lead_notes (lead_id, body, created_at) VALUES (?, ?, ?) RETURNING *")
      .get(leadId, body, new Date().toISOString()) as Record<string, unknown>;
    return toNote(row);
  });
}

export function deleteNote(leadId: number, noteId: number): void {
  withDb((db) => {
    db.prepare("DELETE FROM lead_notes WHERE id = ? AND lead_id = ?").run(noteId, leadId);
  });
}
