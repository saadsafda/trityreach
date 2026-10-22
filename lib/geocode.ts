import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, writeTextAtomic } from "@/lib/storage";

/** Address → coordinates for the lead map, via OpenStreetMap's Nominatim.
 *
 * Nominatim is free but asks for at most 1 request/second, an identifying
 * User-Agent, and caching — so lookups run one at a time in a background
 * queue and every answer (including "not found") is stored in
 * data/geocode-cache.json and never asked again. Leads found through Google
 * Maps already carry exact coordinates and never reach this queue. */

const CACHE_PATH = path.join(DATA_DIR, "geocode-cache.json");
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "TrityReach-LeadMap/1.0 (local lead dashboard)";
const REQUEST_GAP_MS = 1_100;

export type GeocodeHit = { lat: number; lng: number } | { miss: true };

/** One queue per server process, kept on globalThis so dev-mode module
 * reloads can't start a second worker (and break the 1 req/s limit). */
type GeocodeState = {
  cache: Record<string, GeocodeHit> | null;
  queue: string[];
  queued: Set<string>;
  running: boolean;
};
const globalState = globalThis as typeof globalThis & { __trityGeocode?: GeocodeState };
const state: GeocodeState = (globalState.__trityGeocode ??= {
  cache: null,
  queue: [],
  queued: new Set<string>(),
  running: false,
});

export function geocodeKey(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

async function loadCache(): Promise<Record<string, GeocodeHit>> {
  if (state.cache) return state.cache;
  try {
    state.cache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8")) as Record<string, GeocodeHit>;
  } catch {
    state.cache = {};
  }
  return state.cache;
}

/** Cached result for each query (undefined = not looked up yet). */
export async function lookupCached(queries: string[]): Promise<Map<string, GeocodeHit | undefined>> {
  const known = await loadCache();
  return new Map(queries.map((query) => [query, known[geocodeKey(query)]]));
}

async function geocodeOne(query: string): Promise<GeocodeHit> {
  const url = `${NOMINATIM_URL}?${new URLSearchParams({ q: query, format: "jsonv2", limit: "1" })}`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429 || response.status >= 500) throw new Error(`Nominatim HTTP ${response.status}`);
  const results = (await response.json()) as { lat?: string; lon?: string }[];
  const first = results[0];
  if (!first?.lat || !first?.lon) return { miss: true };
  return { lat: Number(first.lat), lng: Number(first.lon) };
}

async function drain(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const known = await loadCache();
    while (state.queue.length) {
      const query = state.queue[0];
      try {
        known[geocodeKey(query)] = await geocodeOne(query);
        state.queue.shift();
        state.queued.delete(query);
        await writeTextAtomic(CACHE_PATH, JSON.stringify(known));
      } catch {
        // Rate-limited or offline: back off and keep the query queued.
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
      await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
    }
  } finally {
    state.running = false;
  }
}

/** Queue queries for background lookup; returns how many are still pending. */
export function enqueueGeocode(queries: string[]): number {
  for (const query of queries) {
    if (!state.queued.has(query)) {
      state.queued.add(query);
      state.queue.push(query);
    }
  }
  if (state.queue.length) void drain();
  return state.queue.length;
}
