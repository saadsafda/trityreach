import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "@/lib/storage";
import { isZip } from "@/lib/zip";

/** The Store Finder's search memory (SQLite, written by scrape_leads.py's
 * StoreSearchMemory): how far each Google Maps search was paged and which
 * stores earlier runs already found, so a repeat search continues with new
 * results. Rows are keyed by location — a ZIP code or the lowercased city. */

const MEMORY_PATH = path.join(DATA_DIR, "store-search.db");

export type SearchMemorySummary = {
  /** Stores earlier runs found in these locations (skipped from now on). */
  found: number;
  /** Google searches already started here. */
  searches: number;
  /** …and how many of them have no results left. */
  usedUp: number;
};

/** Must match memory_location_key() in scrape_leads.py. */
export function memoryLocationKey(location: string): string {
  const value = location.trim().replace(/\s+/g, " ");
  return isZip(value) ? value : value.toLowerCase();
}

function placeholders(keys: string[]): string {
  return keys.map(() => "?").join(", ");
}

export function readSearchMemory(locations: string[]): SearchMemorySummary {
  const keys = [...new Set(locations.map(memoryLocationKey))];
  if (!keys.length || !existsSync(MEMORY_PATH)) return { found: 0, searches: 0, usedUp: 0 };
  const db = new DatabaseSync(MEMORY_PATH, { readOnly: true });
  try {
    const places = db
      .prepare(`SELECT COUNT(*) AS n FROM places WHERE location IN (${placeholders(keys)})`)
      .get(...keys) as { n: number };
    const searches = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(exhausted), 0) AS used FROM searches WHERE location IN (${placeholders(keys)})`,
      )
      .get(...keys) as { n: number; used: number };
    return { found: Number(places.n), searches: Number(searches.n), usedUp: Number(searches.used) };
  } finally {
    db.close();
  }
}

/** Start these locations over: their searches page from the top again and
 * stores found before can be found again. */
export function forgetSearchMemory(locations: string[]): void {
  const keys = [...new Set(locations.map(memoryLocationKey))];
  if (!keys.length || !existsSync(MEMORY_PATH)) return;
  const db = new DatabaseSync(MEMORY_PATH);
  try {
    db.prepare(`DELETE FROM places WHERE location IN (${placeholders(keys)})`).run(...keys);
    db.prepare(`DELETE FROM searches WHERE location IN (${placeholders(keys)})`).run(...keys);
  } finally {
    db.close();
  }
}
