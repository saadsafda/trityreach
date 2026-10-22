import catalog from "@/store-types.json";

/** A Store Finder category. Built-ins come from store-types.json (shared
 * with scrape_leads.py); the user's own additions and removals are stored in
 * data/store-types.json (lib/store-catalog.ts) and merged in by the
 * /api/store-types route. `singular` is the exact label the scraper writes
 * into a lead's store_type column. */
export type StoreTypeDef = {
  key: string;
  label: string;
  singular: string;
  color: string;
  hint: string;
  /** Google Maps search phrases ("dollar store", "99 cent store"…). */
  queries: string[];
  custom: boolean;
  /** Removed from the picker by the user (built-ins only; restorable). */
  hidden: boolean;
};

export const BUILT_IN_STORE_TYPES: StoreTypeDef[] = catalog.types.map((type) => ({
  key: type.key,
  label: type.label,
  singular: type.singular,
  color: type.color,
  hint: type.hint,
  queries: [...type.queries],
  custom: false,
  hidden: false,
}));

/** What a wholesale supplier of everyday goods usually wants first. */
export const DEFAULT_STORE_TYPES: string[] = [...catalog.defaults];

/** Colours handed to user-added types, in order. */
export const CUSTOM_STORE_COLORS = ["#0f766e", "#be185d", "#4d7c0f", "#b45309", "#1e40af", "#9333ea", "#0e7490", "#a16207"];

/** Rough Google Places Text Search price per request with phone/website
 * fields (Enterprise SKU). Mirrors PLACES_COST_PER_REQUEST in Python. */
export const PLACES_COST_PER_REQUEST = 0.035;
/** Google returns at most 3 pages × 20 = 60 results for any one search. */
export const RESULTS_PER_SEARCH = 60;
/** Never let one run spend more than this many Maps requests (~$14). */
export const MAX_REQUESTS_PER_RUN = 400;

export type StoreSearchPlan = {
  /** Distinct Google searches: every phrase of every type, in every location. */
  searches: number;
  /** Most listings Google can return for these searches (before filtering). */
  maxListings: number;
  /** Maps request budget for the run. */
  budget: number;
  /** Rough share of listings that survive the chain/duplicate/contact filters. */
  likelyStores: number;
};

/** How far a Store Finder selection can go. A fresh area gives about 6
 * usable stores per request, but areas searched before give far fewer (most
 * results are already in ERP), so the budget allows target ÷ 2 requests — at
 * least two passes over every type × location, capped per run. It is only a
 * ceiling: the run stops as soon as the target is reached, and it isn't
 * capped at the searches' pages because used-up ZIP searches continue over
 * smaller areas. */
export function storeSearchPlan(selected: StoreTypeDef[], locationCount: number, target: number): StoreSearchPlan {
  const locations = Math.max(0, locationCount);
  const searches = selected.reduce((sum, type) => sum + type.queries.length, 0) * locations;
  const onePass = selected.length * locations;
  const budget = Math.min(MAX_REQUESTS_PER_RUN, Math.max(onePass * 2, Math.ceil(target / 2)));
  return {
    searches,
    maxListings: searches * RESULTS_PER_SEARCH,
    budget,
    likelyStores: Math.round(Math.min(searches * RESULTS_PER_SEARCH * 0.45, budget * 6)),
  };
}

/** Map pin colour for a lead's store_type (the singular label the scraper
 * writes), grey when it has none. */
export const OTHER_STORE_COLOR = "#8a879a";

export function storeTypeColor(storeType: string, types: StoreTypeDef[] = BUILT_IN_STORE_TYPES): string {
  return types.find((type) => type.singular === storeType)?.color ?? OTHER_STORE_COLOR;
}

/** "Smoke shops" → "Smoke shop", "Bakeries" → "Bakery", "Boxes" → "Box". */
export function singularize(label: string): string {
  const words = label.trim().split(/\s+/);
  const last = words.pop() ?? "";
  const lower = last.toLowerCase();
  let singular = last;
  if (/[^aeiou]ies$/.test(lower)) singular = `${last.slice(0, -3)}y`;
  else if (/(?:ss|sh|ch|x|z)es$/.test(lower)) singular = last.slice(0, -2);
  else if (/[^s]s$/.test(lower)) singular = last.slice(0, -1);
  return [...words, singular].join(" ");
}
