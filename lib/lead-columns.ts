/** Matching an uploaded file's columns to lead fields (client-safe). */

export const IMPORT_TARGETS = [
  { key: "business_name", label: "Business name", required: true },
  { key: "contact_name", label: "Contact person" },
  { key: "first_name", label: "Contact first name" },
  { key: "last_name", label: "Contact last name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "website", label: "Website" },
  { key: "address", label: "Street address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "ZIP code" },
  { key: "store_type", label: "Store type" },
  { key: "lat", label: "Latitude" },
  { key: "lng", label: "Longitude" },
] as const;

export type ImportTarget = (typeof IMPORT_TARGETS)[number]["key"];
/** Target field → column index in the file (-1 = not in the file). */
export type ColumnMapping = Record<ImportTarget, number>;

/** Header spellings seen in real lead lists and CRM exports, per field.
 * Compared after lowercasing and stripping punctuation. */
const SYNONYMS: Record<ImportTarget, string[]> = {
  business_name: ["business name", "business", "company", "company name", "store", "store name", "shop", "shop name", "account", "account name", "organization", "organisation", "customer", "customer name", "lead name", "dba", "name"],
  contact_name: ["contact", "contact name", "contact person", "owner", "owner name", "full name", "person", "buyer", "manager"],
  first_name: ["first name", "firstname", "given name"],
  last_name: ["last name", "lastname", "surname", "family name"],
  phone: ["phone", "phone number", "telephone", "tel", "mobile", "mobile no", "mobile number", "cell", "cell phone", "contact number", "number", "phone 1", "primary phone", "business phone"],
  email: ["email", "e mail", "email address", "email id", "mail", "contact email"],
  website: ["website", "web site", "url", "web", "site", "domain", "homepage", "website url"],
  address: ["address", "street", "street address", "address 1", "address line 1", "address1", "full address", "location", "custom address"],
  city: ["city", "town", "locality"],
  state: ["state", "province", "region", "st"],
  zip: ["zip", "zip code", "zipcode", "postal code", "postcode", "pincode", "postal"],
  store_type: ["store type", "type", "category", "business type", "industry", "segment", "channel"],
  lat: ["lat", "latitude"],
  lng: ["lng", "lon", "long", "longitude"],
};

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[_\-./#:]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

/** Best guess per field: an exact synonym (or our own CSV export's field
 * name) wins; each column is used for at most one field. */
export function guessMapping(headers: string[]): ColumnMapping {
  const normalized = headers.map(normalizeHeader);
  const used = new Set<number>();
  const mapping = Object.fromEntries(IMPORT_TARGETS.map((target) => [target.key, -1])) as ColumnMapping;
  for (const target of IMPORT_TARGETS) {
    const names = [normalizeHeader(target.key), ...SYNONYMS[target.key]];
    for (const name of names) {
      const index = normalized.findIndex((header, column) => header === name && !used.has(column));
      if (index >= 0) {
        mapping[target.key] = index;
        used.add(index);
        break;
      }
    }
  }
  return mapping;
}

/** One file row → lead fields, joining split columns (first + last name;
 * street + city + state + ZIP into one address). */
export function rowToLead(row: string[], mapping: ColumnMapping, defaults: { store_type: string }): Record<string, string> {
  const get = (key: ImportTarget) => (mapping[key] >= 0 ? (row[mapping[key]] ?? "").trim() : "");
  const contact = get("contact_name") || [get("first_name"), get("last_name")].filter(Boolean).join(" ");
  const street = get("address");
  const city = get("city");
  const stateZip = [get("state"), get("zip")].filter(Boolean).join(" ");
  const parts = [street];
  if (city && !street.toLowerCase().includes(city.toLowerCase())) parts.push(city);
  if (stateZip && !street.includes(get("zip") || "\u0000")) parts.push(stateZip);
  return {
    business_name: get("business_name"),
    contact_name: contact,
    email: get("email"),
    phone: get("phone"),
    website: get("website"),
    city,
    address: parts.filter(Boolean).join(", "),
    store_type: get("store_type") || defaults.store_type,
    lat: get("lat"),
    lng: get("lng"),
  };
}
