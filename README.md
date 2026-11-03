# TrityReach lead scraper

This local scraper finds businesses from a keyword/location query and extracts
business name, contact name, email, phone, website, city, and address. Results
are written to `leads.csv`; discovered websites are written to `urls.txt`.

There are three discovery sources:

- **Store Finder** (`--source stores`, needs `GOOGLE_MAPS_API_KEY`) — built for
  wholesale suppliers (Cotton Valley / Universal Distribution): pick store
  types (supermarkets, dollar, convenience, variety, international grocery,
  pharmacy, hardware, home goods, restaurants & delis) and one or more
  locations. Google Maps is searched round-robin across every type × location;
  closed, off-type and uncontactable listings are dropped, and with
  `--independent-only` so are national/regional chains (known names, plus any
  name seen at 3+ locations in a run) — chains buy through head office.
  `--max-requests` caps Google spend (~$0.035 per request). Each lead gets a
  `store_type`, and its address/type/rating go into the ERPNext Lead's notes.
  Locations can be cities or **5-digit US ZIP codes**: the dashboard resolves a
  ZIP's centre (OpenStreetMap Nominatim, cached in `data/zip-cache.json`) and
  passes it as `08817@lat,lng`; Google Maps is then restricted to the area and
  results are kept only inside the ZIP (`--zip-radius 0`) or within N miles.
  Built-in store types live in `store-types.json` (shared by the scraper and
  the dashboard); types you add or remove on the dashboard (**+ Add / remove
  types**) are saved to `data/store-types.json`. Targets go up to 1,000 stores
  per run; Google returns at most 60 results per search phrase per city, so
  big targets need several cities/types (the dashboard shows what a selection
  can reach and its cost, capped at 400 requests ≈ $14).
  Example: `venv/bin/python scrape_leads.py --source stores --store-types
  dollar,supermarket --locations "Edison, NJ|Newark, NJ" --independent-only
  --max-results 25 --no-outreach`
- **Google Maps** (`--source maps`, needs `GOOGLE_MAPS_API_KEY`) — the most
  reliable: real businesses with phone and address, including ones with no
  website. Each lead's website is then crawled for its email and contact person.
- **Web search** (`--source web`, the default, free) — searches Yahoo and other
  engines via `ddgs`. Business sites become leads directly; directory and
  "best X in Y" guide pages are not leads, but the crawler follows their
  outbound links to the businesses they list. News, finance, government, and
  social pages are dropped. Free search engines throttle and vary from run to
  run, so this source is less predictable than Google Maps.

Every website is read with [Crawl4AI](https://github.com/unclecode/crawl4ai) in
a stealth headless Chromium (JavaScript-rendered sites work): the homepage plus
up to three contact/about pages. Contacts come straight from the HTML —
schema.org data, `mailto:`/`tel:` links, and page text — so **no LLM is
required**. A site must mention the searched business type and place and
publish an email or phone to count as a lead. When `OPENAI_API_KEY` works, one
small model call per site additionally confirms the match and fills missing
fields; anything contact-like the model returns must appear verbatim on the
page, so it can't invent details. A field stays blank when the business doesn't
publish it. Sites behind hard anti-bot walls (Akamai, DataDome, Cloudflare
challenges) are skipped.

## Configure

The Python 3.12 virtual environment and Chromium browser are already installed
in `venv/`. Create your local secret file:

```bash
cp .env.example .env
```

Add the keys you use to `.env` (all optional — see `.env.example`). To crawl
your own list instead of searching, put one URL per line in `urls.txt`.

## Run

On macOS or Linux:

```bash
venv/bin/python scrape_leads.py
```

On Windows (after creating a Windows virtual environment):

```powershell
venv\Scripts\python.exe scrape_leads.py
```

The existing CSV is replaced only after a scrape returns valid rows. Optional
input and output paths can be supplied with `--urls` and `--output`.

To discover and scrape leads from a keyword/location query directly:

```bash
venv/bin/python scrape_leads.py --query "Independent dentists in Manchester, UK" --max-results 5 --discovered-output urls.txt
```

To rebuild the environment later:

```bash
python3.12 -m venv venv
venv/bin/python -m pip install -r requirements.txt
venv/bin/playwright install chromium
venv/bin/crawl4ai-setup
```

## Automated outreach (n8n)

When `N8N_WEBHOOK_URL` is set in `.env` (or `--webhook-url` is passed) and the
run isn't started with `--no-outreach` (the dashboard's **Auto-call new leads**
switch, off by default), every saved lead is POSTed as JSON to the n8n outreach workflow after the CSV is
written. The workflow drafts a personalized message with AI, then routes by
available data: WhatsApp (Unipile) when a phone number exists, email (Gmail)
when an email exists, an AI phone call (Retell AI) when there is a phone but no
email, and finally logs each lead to CRM (ERPNext, as a `Lead` doctype record
at `https://portal.cottonvalley.net`). Webhook delivery failures are logged but
never abort a scrape.

The WhatsApp, Retell AI, and ERPNext nodes ship disabled until their API
credentials are added in n8n; the email and AI-drafting steps work out of the
box.

n8n also has 3 disabled "Log Conversation" nodes (one after each of the
WhatsApp, Email, and Retell call branches) that POST the exact message/script
that was sent back to this app's `/api/conversations` endpoint, so `/leads` can
show a real conversation thread per lead. Since n8n runs remotely and this app
runs on your machine, n8n needs a URL that reaches you — run a tunnel (e.g.
`ngrok http 3000`) and put `<tunnel-url>/api/conversations` plus your
`INBOUND_WEBHOOK_SECRET` (see below) into all 3 nodes, then enable them.

## Local dashboard

The Next.js dashboard is a 2-page app built with Tailwind CSS:

- **`/` — Workflow & Execution**: keyword/location lead discovery, a "Run
  scrape" control, live progress, a live activity feed (discovery → scraping →
  enrichment → outreach delivery, streamed from `scrape_leads.py` as it runs),
  summary metrics, sortable/searchable results, and CSV export.
- **`/leads` — CRM & Conversations**: every saved lead with a color-coded
  channel-status badge (WhatsApp/Email/Call) showing how it's been contacted.
  Click a row to open the conversation thread — the exact WhatsApp message,
  email, or call script n8n sent, read live from `data/conversations.json`.
  Each row (and the thread panel) has **Call** and **Email** buttons that
  trigger the n8n workflow for that lead on the chosen channel, and the header
  has **Call all leads** — all go through `POST /api/outreach` (body:
  `{leadKey | all, channel}`), which forwards the lead(s) plus the channel to
  `N8N_WEBHOOK_URL` server-side and logs an `outreach_sent` activity event.
  Note: there is no dedupe ledger, so sending the same lead twice triggers
  outreach twice.

  **Channel routing**: the n8n workflow branches on the `channel` field in the
  webhook payload (`call` / `email` / `whatsapp`). When the field is absent —
  e.g. leads auto-posted by the scraper after a run — it defaults to **call**,
  so automatic outreach is calls-only; email and WhatsApp fire only when
  explicitly chosen from the dashboard.

  **Upload leads**: the CRM's "Upload leads" button imports a CSV or Excel
  (.xlsx) list — up to 5,000 rows / 5 MB per file. Columns are matched from
  their headers (Company, Store Name, Phone, Cell, E-mail, Address, City,
  State, ZIP, Store type…; editable before import), split columns are joined
  (first + last name; street + city + state + ZIP). Rows need a business name
  and a phone or email; duplicates within the file, already in the CRM
  (email or phone, any formatting), or optionally already in the ERP are
  skipped. Imported leads are saved as manual leads. No outreach is sent.

  **Manual leads**: the "Add lead" button opens a form that saves to
  `data/manual-leads.json` via `POST /api/leads` (requires a business name plus
  an email or phone; duplicates by email/phone are rejected). Manual leads are
  merged with scraped ones everywhere — table, outreach buttons, CSV export —
  and are kept in a separate file precisely so the scraper's `leads.csv`
  rewrite on each run never deletes them.

- **`/map` — Lead map**: every lead from the latest run plus every Lead in the
  connected ERPNext, as pins coloured by store type (Leaflet + OpenStreetMap
  tiles, no API key). Store Finder / Google Maps leads carry exact coordinates
  (`lat`/`lng` columns, also saved as a map link in the ERPNext note). Older
  leads are geocoded once from their address (note, or a `custom_address`
  field) or, failing that, placed at their city (shown hollow) — via
  OpenStreetMap Nominatim at 1 request/second, cached in
  `data/geocode-cache.json`.

Every lead from every source is also kept in `data/leads.db` (SQLite), along
with the notes on it. `leads.csv` only holds the latest run, so Discovery shows
that run while the CRM lists the whole database. **Import from ERP** on the CRM
page copies existing ERPNext Leads in; it only reads from ERPNext. **Call latest
leads** deliberately covers the latest run and hand-added leads, not the whole
database.

Both pages poll the same on-disk state (`leads.csv`, `data/*`) that
`scrape_leads.py` and the n8n workflow write to — nothing on either page is
mock data.

Install and start it:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The Next.js server starts
`scrape_leads.py` using the existing virtual environment. URLs, job status,
activity events, conversation logs, and CSV results are stored on disk, so
refreshing or restarting the dashboard does not clear completed results.

### Securing the inbound webhooks

`/api/activity` and `/api/conversations` accept POST requests from the scraper
and from n8n. Set `INBOUND_WEBHOOK_SECRET` in `.env` (generate one with
`python3 -c "import secrets; print(secrets.token_urlsafe(24))"`) and n8n's "Log
Conversation" nodes must send it as `Authorization: Bearer <secret>`. Leave it
unset only for local-only use with no tunnel exposed.
