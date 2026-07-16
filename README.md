# TrityReach lead scraper

This local scraper uses DuckDuckGo discovery, ScrapeGraphAI, Playwright, and
OpenAI `gpt-4o-mini` to find businesses from a keyword/location query and then
extract business name, contact name, email, phone, website, city, and address.
Results are written to `leads.csv`; discovered websites are written to
`urls.txt`.

Search results are treated as candidate sources rather than guaranteed leads.
The scraper checks extra candidates until it reaches the requested lead target
or exhausts the search pool. After a lead is identified, it visits both the
original source page and the official website, follows contact/about pages, and
uses a headless-browser fallback for JavaScript-rendered sites. This recovers
public email, phone number, and postal address data that was not present on the
search page. Addresses are read from schema.org / `<address>` markup, which
keeps false positives low. A field remains blank when the business does not
publish it publicly; the scraper never invents contact details.

## Configure

The Python 3.12 virtual environment and Chromium browser are already installed
in `venv/`. Create your local secret file:

```bash
cp .env.example .env
```

Replace the placeholder in `.env` with your real OpenAI API key, then edit
`urls.txt` so it contains one target URL per line.

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
```

## Automated outreach (n8n)

When `N8N_WEBHOOK_URL` is set in `.env` (or `--webhook-url` is passed), every
saved lead is POSTed as JSON to the n8n outreach workflow after the CSV is
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

  **Manual leads**: the "Add lead" button opens a form that saves to
  `data/manual-leads.json` via `POST /api/leads` (requires a business name plus
  an email or phone; duplicates by email/phone are rejected). Manual leads are
  merged with scraped ones everywhere — table, outreach buttons, CSV export —
  and are kept in a separate file precisely so the scraper's `leads.csv`
  rewrite on each run never deletes them.

Both pages poll the same on-disk state (`leads.csv`, `data/*.json`) that
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
