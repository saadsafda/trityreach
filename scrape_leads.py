#!/usr/bin/env python3
"""Extract structured business leads from the URLs in ``urls.txt``."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from scrapegraphai.graphs import SmartScraperMultiGraph
from scrapegraphai.utils.research_web import search_on_web


BASE_DIR = Path(__file__).resolve().parent
CSV_FIELDS = (
    "business_name",
    "contact_name",
    "email",
    "phone",
    "website",
    "city",
    "address",
)

BLOCKED_DISCOVERY_DOMAINS = {
    "bing.com",
    "duckduckgo.com",
    "facebook.com",
    "girlgonelondon.com",
    "google.com",
    "instagram.com",
    "linkedin.com",
    "quora.com",
    "reddit.com",
    "tiktok.com",
    "twitter.com",
    "wikipedia.org",
    "x.com",
    "yelp.ca",
    "yelp.com",
    "youtube.com",
}

# --- Deep contact scraping -------------------------------------------------
#
# The LLM extraction step reads a single rendered page, so it frequently misses
# the email/phone that live on a dedicated contact or about page. After a lead
# is extracted we visit the lead's own website, follow its contact/about links,
# and pull the email and phone straight out of the HTML.

CONTACT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
CONTACT_REQUEST_TIMEOUT = 12
CONTACT_MAX_PAGES = 4
CONTACT_MAX_TOTAL_PAGES = 10
BROWSER_PAGE_TIMEOUT_MS = 18_000
# Link text / paths that are likely to hold contact details.
CONTACT_PAGE_HINTS = (
    "contact",
    "contact-us",
    "contactus",
    "about",
    "about-us",
    "aboutus",
    "get-in-touch",
    "reach-us",
    "support",
    "impressum",
)
OFFICIAL_LINK_HINTS = (
    "official website",
    "visit website",
    "visit site",
    "company website",
    "business website",
    "homepage",
    "website",
)
DIRECTORY_DOMAINS = {
    "allinlondon.co.uk",
    "bizseek.co.uk",
    "cylex-uk.co.uk",
    "find-and-update.company-information.service.gov.uk",
    "loc8nearme.com",
    "opengovuk.com",
    "tripadvisor.com",
    "yell.com",
    "yellowpages.ca",
    "yellowpages.com",
}

EMAIL_RE = re.compile(
    r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}",
)
OBFUSCATED_EMAIL_RE = re.compile(
    r"([A-Za-z0-9._%+\-]+)\s*(?:\[at\]|\(at\)|\sat\s)\s*"
    r"([A-Za-z0-9.\-]+)\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*([A-Za-z]{2,})",
    re.IGNORECASE,
)
# Matches most international and local phone formats (optional +, single spaces,
# dashes and parentheses). Deliberately excludes periods and multi-space runs so
# it does not span sentence boundaries like "© 2009. 2011-2012".
PHONE_RE = re.compile(
    r"(?:\+?\(?\d[\d\-() ]{5,17}\d)",
)
# Emails we never want to treat as a real business contact.
JUNK_EMAIL_SUBSTRINGS = (
    "example.com",
    "sentry.io",
    "wixpress.com",
    "@2x",
    "@3x",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    "your@email",
    "email@",
    "user@",
    "name@",
    "domain.com",
    "noreply@",
    "no-reply@",
)


def _clean_phone(raw: str, *, from_tel_link: bool = False) -> str:
    """Normalize whitespace and reject strings that are not phone-like.

    ``tel:`` link values are trusted with a looser check; free-text matches must
    look unmistakably like a phone number (international ``+`` prefix, a
    parenthesised area code, or at least 10 digits) so that ids, years, and
    price fragments such as ``84-72503`` or ``1910-1930`` are rejected.
    """
    candidate = " ".join(raw.split()).strip(" .-")
    digits = re.sub(r"\D", "", candidate)
    if not 7 <= len(digits) <= 15:
        return ""
    if from_tel_link:
        return candidate
    # A real phone splits into a handful of digit groups; long chains of small
    # groups (e.g. "2009 2011 2012 700") are dates/ids, not a number.
    groups = [g for g in re.split(r"[^\d]+", candidate) if g]
    if len(groups) > 5:
        return ""
    looks_like_phone = (
        candidate.lstrip().startswith("+")
        or "(" in candidate
        or len(digits) >= 10
    )
    if not looks_like_phone:
        return ""
    return candidate


def _is_real_email(email: str) -> bool:
    lowered = email.lower()
    if any(junk in lowered for junk in JUNK_EMAIL_SUBSTRINGS):
        return False
    # Drop obvious image/asset filenames that slipped past the regex.
    return "." in email.split("@")[-1]


def _clean_address(value: str) -> str:
    """Normalize whitespace and reject strings that are not address-like."""
    candidate = " ".join((value or "").split()).strip(" ,;")
    if len(candidate) < 8 or len(candidate) > 200:
        return ""
    # A real postal address contains at least one digit (street/unit/postcode).
    if not any(char.isdigit() for char in candidate):
        return ""
    return candidate


def _format_postal_address(node: Any) -> str:
    """Join the parts of a schema.org PostalAddress object into one line."""
    if isinstance(node, list):
        node = node[0] if node else None
    if not isinstance(node, dict):
        return _clean_address(str(node)) if node else ""

    def _part(value: Any) -> str:
        # A sub-field such as addressCountry may itself be a {name: ...} object.
        if isinstance(value, dict):
            value = value.get("name") or value.get("@id") or ""
        return str(value).strip() if value else ""

    parts = [
        _part(node.get("streetAddress")),
        _part(node.get("addressLocality")),
        _part(node.get("addressRegion")),
        _part(node.get("postalCode")),
        _part(node.get("addressCountry")),
    ]
    joined = ", ".join(part for part in parts if part)
    return _clean_address(joined)


def _addresses_from_jsonld(soup: BeautifulSoup) -> list[str]:
    """Read postal addresses from schema.org JSON-LD blocks."""
    addresses: list[str] = []

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            if "address" in node:
                formatted = _format_postal_address(node["address"])
                if formatted and formatted not in addresses:
                    addresses.append(formatted)
            for value in node.values():
                _walk(value)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    for script in soup.find_all("script", type="application/ld+json"):
        raw = script.string or script.get_text()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        _walk(data)
    return addresses


def _extract_contacts_from_html(
    html: str,
) -> tuple[list[str], list[str], list[str]]:
    """Pull emails, phone numbers, and postal addresses out of a page's HTML."""
    soup = BeautifulSoup(html, "html.parser")

    emails: list[str] = []
    phones: list[str] = []
    addresses: list[str] = []

    def _add_email(value: str) -> None:
        value = value.strip().strip(".,;:")
        if value and _is_real_email(value) and value.lower() not in {e.lower() for e in emails}:
            emails.append(value)

    def _add_phone(value: str, *, from_tel_link: bool = False) -> None:
        cleaned = _clean_phone(value, from_tel_link=from_tel_link)
        if cleaned and cleaned not in phones:
            phones.append(cleaned)

    def _add_address(value: str) -> None:
        cleaned = _clean_address(value)
        if cleaned and cleaned.lower() not in {a.lower() for a in addresses}:
            addresses.append(cleaned)

    # mailto: / tel: links are the most reliable signal.
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if href.lower().startswith("mailto:"):
            _add_email(href[7:].split("?")[0])
        elif href.lower().startswith("tel:"):
            _add_phone(href[4:], from_tel_link=True)

    # Cloudflare replaces visible email addresses with an encoded data-cfemail
    # attribute. Decode it before falling back to visible-text matching.
    for node in soup.select("[data-cfemail]"):
        encoded = str(node.get("data-cfemail", ""))
        try:
            key = int(encoded[:2], 16)
            decoded = "".join(
                chr(int(encoded[index : index + 2], 16) ^ key)
                for index in range(2, len(encoded), 2)
            )
            _add_email(decoded)
        except (ValueError, IndexError):
            continue

    text = soup.get_text(separator=" ")
    for match in EMAIL_RE.findall(text):
        _add_email(match)
    for local, domain, suffix in OBFUSCATED_EMAIL_RE.findall(text):
        _add_email(f"{local}@{domain}.{suffix}")
    for match in PHONE_RE.findall(text):
        _add_phone(match)

    # Addresses: prefer structured schema.org data, then <address> tags, then
    # itemprop markup. These have far fewer false positives than free-text.
    for address in _addresses_from_jsonld(soup):
        _add_address(address)
    for tag in soup.find_all("address"):
        _add_address(tag.get_text(" ", strip=True))
    for tag in soup.find_all(attrs={"itemprop": "address"}):
        _add_address(tag.get_text(" ", strip=True))

    return emails, phones, addresses


def _find_contact_links(html: str, base_url: str) -> list[str]:
    """Return same-site contact/about page URLs discovered on the page."""
    soup = BeautifulSoup(html, "html.parser")
    base_host = (urlparse(base_url).hostname or "").lower().removeprefix("www.")
    found: list[str] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if not href or href.startswith(("mailto:", "tel:", "#", "javascript:")):
            continue
        absolute = urljoin(base_url, href)
        parsed = urlparse(absolute)
        if parsed.scheme not in {"http", "https"}:
            continue
        host = (parsed.hostname or "").lower().removeprefix("www.")
        if host != base_host:
            continue
        haystack = f"{parsed.path} {anchor.get_text(' ', strip=True)}".lower()
        if not any(hint in haystack for hint in CONTACT_PAGE_HINTS):
            continue
        key = absolute.rstrip("/").lower()
        if key in seen:
            continue
        seen.add(key)
        found.append(absolute)
    return found


def _fetch_page(session: requests.Session, url: str) -> str:
    try:
        response = session.get(url, timeout=CONTACT_REQUEST_TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "").lower()
        if "html" not in content_type and content_type:
            return ""
        return response.text
    except requests.RequestException:
        return ""


def _normalized_web_url(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if not value.startswith(("http://", "https://")):
        value = f"https://{value}"
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return urlunparse(parsed._replace(fragment=""))


def _hostname(value: str) -> str:
    return (urlparse(value).hostname or "").lower().removeprefix("www.")


def _is_directory_url(value: str) -> bool:
    host = _hostname(value)
    return any(host == domain or host.endswith(f".{domain}") for domain in DIRECTORY_DOMAINS)


def _find_official_website_links(
    html: str, base_url: str, business_name: str
) -> list[str]:
    """Find likely official-site links on a directory or search-result page."""
    soup = BeautifulSoup(html, "html.parser")
    base_host = _hostname(base_url)
    name_tokens = {
        token.lower()
        for token in re.findall(r"[A-Za-z0-9]+", business_name)
        if len(token) >= 4
    }
    found: list[str] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        absolute = _normalized_web_url(urljoin(base_url, anchor["href"].strip()))
        if not absolute:
            continue
        host = _hostname(absolute)
        if not host or host == base_host or is_blocked_discovery_domain(host):
            continue
        if urlparse(absolute).path.lower().endswith(
            (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".jpg", ".png")
        ):
            continue
        label = " ".join(
            filter(
                None,
                [
                    anchor.get_text(" ", strip=True),
                    str(anchor.get("title", "")),
                    str(anchor.get("aria-label", "")),
                ],
            )
        ).lower()
        label_tokens = set(re.findall(r"[a-z0-9]+", label))
        has_hint = any(hint in label for hint in OFFICIAL_LINK_HINTS)
        name_match = bool(name_tokens) and len(name_tokens & label_tokens) >= min(2, len(name_tokens))
        if not (has_hint or name_match):
            continue
        key = absolute.rstrip("/").lower()
        if key in seen:
            continue
        seen.add(key)
        found.append(absolute)
    return found


def _fetch_rendered_page(browser: Any, url: str) -> str:
    """Fetch a JavaScript-rendered page with the shared Playwright browser."""
    page = None
    try:
        page = browser.new_page(user_agent=CONTACT_USER_AGENT)
        page.goto(url, wait_until="domcontentloaded", timeout=BROWSER_PAGE_TIMEOUT_MS)
        page.wait_for_timeout(900)
        return page.content()
    except Exception:  # noqa: BLE001 - browser fallback must not abort a lead
        return ""
    finally:
        if page is not None:
            page.close()


def _choose_email(emails: list[str], official_url: str) -> str:
    official_host = _hostname(official_url)

    def score(email: str) -> tuple[int, int]:
        local, _, domain = email.lower().partition("@")
        points = 0
        if domain and (domain == official_host or official_host.endswith(f".{domain}")):
            points += 4
        if any(word in local for word in ("contact", "info", "hello", "sales", "support", "office")):
            points += 3
        if any(word in local for word in ("privacy", "legal", "careers", "jobs", "noreply", "no-reply")):
            points -= 4
        return points, -len(email)

    return max(emails, key=score) if emails else ""


def scrape_lead_contacts(
    row: dict[str, str], *, browser: Any = None
) -> tuple[str, str, str, str]:
    """Inspect a lead's source page, official site, and contact/about pages.

    Returns ``(email, phone, address, official_url)``. When ``browser`` is
    supplied, pages are rendered so JavaScript-only contact data can be read.
    """
    website = _normalized_web_url(row.get("website", ""))
    source_url = _normalized_web_url(row.get("_source_url", ""))
    seeds = [url for url in (source_url, website) if url]
    if not seeds:
        return "", "", "", ""

    session = requests.Session()
    session.headers.update({"User-Agent": CONTACT_USER_AGENT})
    queue = list(dict.fromkeys(seeds))
    queued = {url.rstrip("/").lower() for url in queue}
    visited: set[str] = set()
    emails: list[str] = []
    phones: list[str] = []
    addresses: list[str] = []
    official_url = website if website and not _is_directory_url(website) else ""
    business_name = row.get("business_name", "")

    def merge(found: tuple[list[str], list[str], list[str]]) -> None:
        found_emails, found_phones, found_addresses = found
        for email in found_emails:
            if email.lower() not in {item.lower() for item in emails}:
                emails.append(email)
        for phone in found_phones:
            if phone not in phones:
                phones.append(phone)
        for address in found_addresses:
            if address.lower() not in {item.lower() for item in addresses}:
                addresses.append(address)

    while queue and len(visited) < CONTACT_MAX_TOTAL_PAGES:
        current = queue.pop(0)
        key = current.rstrip("/").lower()
        if key in visited:
            continue
        visited.add(key)
        html = _fetch_rendered_page(browser, current) if browser else _fetch_page(session, current)
        if not html:
            continue
        merge(_extract_contacts_from_html(html))

        for link in _find_contact_links(html, current)[:CONTACT_MAX_PAGES]:
            link_key = link.rstrip("/").lower()
            if link_key not in queued:
                queued.add(link_key)
                queue.append(link)

        # Some client-rendered sites do not expose navigation links in the
        # initial HTML. Try the most common contact paths on likely official
        # sites before falling back to the rendered-browser pass.
        if not _is_directory_url(current):
            parsed_current = urlparse(current)
            site_root = f"{parsed_current.scheme}://{parsed_current.netloc}/"
            for guessed_path in ("contact", "contact-us", "about-us"):
                guessed = urljoin(site_root, guessed_path)
                guessed_key = guessed.rstrip("/").lower()
                if guessed_key not in queued:
                    queued.add(guessed_key)
                    queue.append(guessed)

        for link in _find_official_website_links(html, current, business_name)[:2]:
            source_host = _hostname(source_url)
            website_is_source = bool(website and source_url and _hostname(website) == source_host)
            if (
                not official_url
                or _is_directory_url(official_url)
                or (website_is_source and _hostname(current) == source_host)
            ):
                official_url = link
            link_key = link.rstrip("/").lower()
            if link_key not in queued:
                queued.add(link_key)
                queue.append(link)

        if emails and phones and addresses:
            break

    preferred_url = official_url or website or source_url
    return (
        _choose_email(emails, preferred_url),
        phones[0] if phones else "",
        addresses[0] if addresses else "",
        official_url,
    )


def scrape_website_contacts(website: str) -> tuple[str, str, str]:
    """Backward-compatible helper for scraping one website deeply."""
    email, phone, address, _ = scrape_lead_contacts({"website": website})
    return email, phone, address


def enrich_rows_with_contacts(
    rows: list[dict[str, str]],
    *,
    progress: ProgressReporter | None = None,
    activity: ActivityLogger | None = None,
) -> list[dict[str, str]]:
    """Fill missing contacts from source/official sites, rendering when needed."""
    playwright = None
    browser = None

    def apply_details(
        row: dict[str, str], details: tuple[str, str, str, str]
    ) -> None:
        email, phone, address, official_url = details
        if email and not row.get("email", "").strip():
            row["email"] = email
        if phone and not row.get("phone", "").strip():
            row["phone"] = phone
        if address and not row.get("address", "").strip():
            row["address"] = address
        if official_url and (
            not row.get("website", "").strip()
            or _is_directory_url(row.get("website", ""))
        ):
            row["website"] = official_url

    try:
        for index, row in enumerate(rows):
            website = row.get("website", "").strip() or row.get("_source_url", "").strip()
            if not website:
                continue
            if progress is not None:
                progress.update(
                    "enriching",
                    current_url=website,
                    message=f"Checking website contact pages ({index + 1} of {len(rows)})",
                )
            print(f"    ↳ Checking source and website for {row.get('business_name') or website}", flush=True)
            apply_details(row, scrape_lead_contacts(row))

            # Static HTTP misses client-rendered contact data. Only pay the
            # browser cost when email or phone is still absent.
            if not row.get("email", "").strip() or not row.get("phone", "").strip():
                if browser is None:
                    try:
                        from playwright.sync_api import sync_playwright

                        playwright = sync_playwright().start()
                        browser = playwright.chromium.launch(headless=True)
                    except Exception as exc:  # noqa: BLE001
                        print(f"    ⚠ Browser enrichment unavailable: {exc}", flush=True)
                        browser = False
                if browser:
                    apply_details(row, scrape_lead_contacts(row, browser=browser))

            found = [
                label
                for label in ("email", "phone", "address")
                if row.get(label, "").strip()
            ]
            if activity is not None:
                activity.log(
                    "enriching",
                    f"Checked contact pages for {row.get('business_name') or website}",
                    detail=f"Found {', '.join(found)}" if found else "No public contact details found",
                )
    finally:
        if browser:
            browser.close()
        if playwright is not None:
            playwright.stop()

    for row in rows:
        row.pop("_source_url", None)
    return rows


class Lead(BaseModel):
    """The fields written for one scraped business."""

    business_name: str | None = Field(
        default=None, description="Official or displayed business name"
    )
    contact_name: str | None = Field(
        default=None, description="Named owner or primary contact person"
    )
    email: str | None = Field(default=None, description="Public contact email")
    phone: str | None = Field(default=None, description="Public contact phone number")
    website: str | None = Field(default=None, description="Canonical business website URL")
    city: str | None = Field(default=None, description="City where the business is located")
    address: str | None = Field(
        default=None,
        description="Full street address (street, area, postcode) if published",
    )


class LeadCollection(BaseModel):
    """Combined result returned by SmartScraperMultiGraph."""

    leads: list[Lead] = Field(default_factory=list)


EXTRACTION_PROMPT = """
Visit every supplied URL and extract one business lead per URL. Return a `leads`
array containing: business_name, contact_name, email, phone, website, city, and
address. Use only information found on the supplied pages. Check obvious
contact/about content made available by the scraper. Use null when a value is
not published; do not guess or invent information. Keep phone numbers in the
format shown on the site. The website field should identify the corresponding
supplied website. The address field should be the full street address (street,
area, and postal/zip code) when it is published.
""".strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--urls",
        type=Path,
        default=BASE_DIR / "urls.txt",
        help="text file containing one http(s) URL per line",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=BASE_DIR / "leads.csv",
        help="destination CSV file",
    )
    parser.add_argument(
        "--progress-file",
        type=Path,
        help="optional JSON status file; enables per-URL progress reporting",
    )
    parser.add_argument(
        "--activity-file",
        type=Path,
        help="optional JSON file to append live activity feed events to",
    )
    parser.add_argument(
        "--job-id",
        default="manual",
        help="identifier written to the progress file",
    )
    parser.add_argument(
        "--query",
        help="discover business websites from this keyword/location query before scraping",
    )
    parser.add_argument(
        "--source",
        choices=("web", "maps"),
        default="web",
        help=(
            "lead discovery source in query mode: 'web' scrapes official websites "
            "(default), 'maps' pulls businesses from Google Maps (Places API) — "
            "including ones with no website"
        ),
    )
    parser.add_argument(
        "--max-results",
        type=int,
        default=5,
        help="maximum websites to discover in query mode (default: 5)",
    )
    parser.add_argument(
        "--discovered-output",
        type=Path,
        help="optional text file where discovered website URLs are saved",
    )
    parser.add_argument(
        "--webhook-url",
        help=(
            "POST each saved lead as JSON to this URL after saving "
            "(default: the N8N_WEBHOOK_URL environment variable)"
        ),
    )
    return parser.parse_args()


def load_urls(path: Path) -> list[str]:
    if not path.is_file():
        raise ValueError(f"URL file not found: {path}")

    urls: list[str] = []
    seen: set[str] = set()
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        value = raw_line.strip()
        if not value or value.startswith("#"):
            continue
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError(f"Invalid URL on line {line_number}: {value}")
        if value not in seen:
            seen.add(value)
            urls.append(value)

    if not urls:
        raise ValueError(f"No URLs found in {path}. Add one website URL per line.")
    return urls


def require_api_key() -> str:
    load_dotenv(BASE_DIR / ".env")
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key or api_key == "your_real_key_here":
        raise ValueError(
            "OPENAI_API_KEY is missing. Copy .env.example to .env and add your key."
        )
    return api_key


def require_maps_api_key() -> str:
    load_dotenv(BASE_DIR / ".env")
    api_key = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()
    if not api_key:
        raise ValueError(
            "GOOGLE_MAPS_API_KEY is missing. Add a Google Places API key to .env "
            "(enable the Places API and billing in Google Cloud Console) to search "
            "Google Maps."
        )
    return api_key


def is_blocked_discovery_domain(hostname: str) -> bool:
    hostname = hostname.lower().removeprefix("www.")
    return any(
        hostname == domain or hostname.endswith(f".{domain}")
        for domain in BLOCKED_DISCOVERY_DOMAINS
    )


PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
# Field mask keeps the response small and the bill low — we only ask for the
# fields that map onto a lead row (New Places API charges by requested fields).
PLACES_FIELD_MASK = (
    "places.displayName,"
    "places.internationalPhoneNumber,"
    "places.nationalPhoneNumber,"
    "places.websiteUri,"
    "places.formattedAddress,"
    "places.addressComponents,"
    "nextPageToken"
)


def _places_city(place: dict[str, Any]) -> str:
    """Pull the city (locality) out of a place's addressComponents."""
    for component in place.get("addressComponents", []):
        types = component.get("types", [])
        if "locality" in types or "postal_town" in types:
            return component.get("longText") or component.get("shortText") or ""
    # Fall back to the administrative area if no locality is present.
    for component in place.get("addressComponents", []):
        if "administrative_area_level_1" in component.get("types", []):
            return component.get("longText") or component.get("shortText") or ""
    return ""


def discover_from_places(query: str, max_results: int, api_key: str) -> list[dict[str, str]]:
    """Return leads for a query straight from the Google Places API (Maps).

    Unlike the web-search discovery path, this returns businesses that have no
    website too — the phone number and address come from the Maps listing, so a
    store owner without a site is still reachable (via the Retell call branch).
    Each returned dict already matches CSV_FIELDS.
    """
    query = " ".join(query.split())
    if len(query) < 3:
        raise ValueError("The search query must contain at least 3 characters.")
    if max_results < 1 or max_results > 100:
        raise ValueError("max-results must be between 1 and 100.")

    leads: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    page_token = ""
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
    }

    # The Places API returns up to 20 results per page; page through until we
    # have enough leads or Google stops handing out a nextPageToken.
    while len(leads) < max_results:
        payload: dict[str, Any] = {"textQuery": query, "pageSize": 20}
        if page_token:
            payload["pageToken"] = page_token
        try:
            response = requests.post(
                PLACES_TEXT_SEARCH_URL, json=payload, headers=headers, timeout=20
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            detail = ""
            if getattr(exc, "response", None) is not None:
                detail = f" (HTTP {exc.response.status_code}: {exc.response.text[:200]})"
            raise ValueError(f"Google Places request failed{detail}") from exc

        data = response.json()
        for place in data.get("places", []):
            name = (place.get("displayName") or {}).get("text", "").strip()
            phone = (
                place.get("internationalPhoneNumber")
                or place.get("nationalPhoneNumber")
                or ""
            ).strip()
            website = _normalized_web_url(place.get("websiteUri", ""))
            address = _clean_address(place.get("formattedAddress", ""))
            city = _places_city(place)
            # Skip listings that carry neither a phone nor a website — nothing to
            # act on (no way to call or email them).
            if not name or not (phone or website):
                continue
            identity = (name.lower(), phone or website.lower())
            if identity in seen:
                continue
            seen.add(identity)
            leads.append(
                {
                    "business_name": name,
                    "contact_name": "",
                    "email": "",  # Maps never exposes email; enrichment fills it if a site exists
                    "phone": phone,
                    "website": website,
                    "city": city,
                    "address": address,
                }
            )
            if len(leads) >= max_results:
                break

        page_token = data.get("nextPageToken", "")
        if not page_token:
            break

    if not leads:
        raise ValueError(
            "Google Maps returned no usable businesses for that query. "
            "Try a more specific business type and location."
        )
    return leads


def discover_urls(query: str, max_results: int) -> list[str]:
    """Find likely official business websites for a natural-language lead query."""
    query = " ".join(query.split())
    if len(query) < 3:
        raise ValueError("The search query must contain at least 3 characters.")
    if max_results < 1 or max_results > 100:
        raise ValueError("max-results must be between 1 and 100.")

    candidates = search_on_web(
        query=f"{query} official website contact",
        max_results=min(100, max(12, max_results * 4)),
        search_engine="duckduckgo",
    )
    discovered: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        parsed = urlparse(candidate)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            continue
        if is_blocked_discovery_domain(parsed.hostname or ""):
            continue
        if parsed.path.lower().endswith((".pdf", ".doc", ".docx", ".xls", ".xlsx")):
            continue
        normalized = urlunparse(parsed._replace(fragment=""))
        dedupe_key = normalized.rstrip("/").lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        discovered.append(normalized)
        if len(discovered) == max_results:
            break

    if not discovered:
        raise ValueError(
            "No suitable business websites were found. Try a more specific keyword and location."
        )
    return discovered


def write_url_list(path: Path, urls: list[str]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    try:
        temporary_path.write_text(f"{'\n'.join(urls)}\n", encoding="utf-8")
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def unpack_leads(result: Any, *, allow_empty: bool = False) -> list[dict[str, str]]:
    """Normalize the schema-aware graph response into CSV-safe dictionaries."""
    if isinstance(result, BaseModel):
        result = result.model_dump()
    if isinstance(result, str):
        text = result.strip()
        if text.startswith("```"):
            text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        try:
            result = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"The model returned an unexpected text response: {text[:200]}") from exc
    if isinstance(result, dict) and "answer" in result:
        return unpack_leads(result["answer"], allow_empty=allow_empty)
    if isinstance(result, dict) and "leads" in result:
        items = result["leads"]
    elif isinstance(result, dict) and any(field in result for field in CSV_FIELDS):
        items = [result]
    elif isinstance(result, list):
        items = result
    else:
        raise ValueError(f"The model returned an unsupported result type: {type(result).__name__}")

    rows: list[dict[str, str]] = []
    for item in items:
        if isinstance(item, BaseModel):
            item = item.model_dump()
        if not isinstance(item, dict):
            continue
        rows.append(
            {
                field: "" if item.get(field) is None else str(item.get(field)).strip()
                for field in CSV_FIELDS
            }
        )
    if not rows and not allow_empty:
        raise ValueError("The scraper completed but did not return any lead rows.")
    return rows


def deduplicate_leads(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    deduplicated: list[dict[str, str]] = []
    seen: set[tuple[str, ...]] = set()
    for row in rows:
        if not any(row.get(field, "").strip() for field in CSV_FIELDS):
            continue
        identity = tuple(
            row.get(field, "").strip().lower()
            for field in (
                "website",
                "email",
                "phone",
                "business_name",
                "address",
                "city",
            )
        )
        if identity in seen:
            continue
        seen.add(identity)
        deduplicated.append(row)
    return deduplicated


def post_rows_to_webhook(url: str, rows: list[dict[str, str]]) -> int:
    """POST each saved lead to the outreach webhook. Returns the number delivered.

    Delivery failures are reported but never abort the scrape - the CSV is
    already saved by the time this runs.
    """
    delivered = 0
    for row in rows:
        label = row.get("business_name") or row.get("website") or "lead"
        try:
            response = requests.post(url, json=row, timeout=15)
            response.raise_for_status()
            delivered += 1
            print(f"    ↳ Sent {label} to outreach webhook", flush=True)
        except requests.RequestException as exc:
            print(f"    ⚠ Webhook delivery failed for {label}: {exc}", flush=True)
    return delivered


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    try:
        with temporary_path.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
            writer.writeheader()
            writer.writerows(rows)
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


ACTIVITY_EVENT_TYPES = frozenset(
    {
        "discovering",
        "scraping",
        "enriching",
        "lead_found",
        "webhook_sent",
        "outreach_sent",
        "completed",
        "failed",
    }
)
MAX_ACTIVITY_EVENTS = 500


class ActivityLogger:
    """Append rows to data/activity.json for the dashboard's live feed.

    Writes the same JSON shape the Next.js app's ActivityEvent type expects,
    so the dashboard can read this file directly with no HTTP round trip.
    """

    def __init__(self, path: Path | None) -> None:
        self.path = path.expanduser().resolve() if path else None

    def log(self, event_type: str, message: str, *, detail: str = "") -> None:
        if self.path is None:
            return
        assert event_type in ACTIVITY_EVENT_TYPES, f"unknown activity type: {event_type}"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        existing: list[dict[str, Any]] = []
        try:
            existing = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(existing, list):
                existing = []
        except (FileNotFoundError, json.JSONDecodeError):
            existing = []
        existing.append(
            {
                "id": str(uuid.uuid4()),
                "type": event_type,
                "message": message,
                "detail": detail or None,
                "createdAt": datetime.now(UTC).isoformat(),
            }
        )
        existing = existing[-MAX_ACTIVITY_EVENTS:]
        temporary_path = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            temporary_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
            temporary_path.replace(self.path)
        finally:
            temporary_path.unlink(missing_ok=True)


class ProgressReporter:
    """Persist scrape progress so another process can monitor the job."""

    def __init__(self, path: Path | None, job_id: str) -> None:
        self.path = path.expanduser().resolve() if path else None
        self.job_id = job_id
        self.total = 0
        self.completed = 0
        self.query = ""
        self.discovered_urls: list[str] = []

    def update(
        self,
        status: str,
        *,
        current_url: str = "",
        message: str = "",
        error: str = "",
    ) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "jobId": self.job_id,
            "status": status,
            "currentUrl": current_url,
            "completed": self.completed,
            "total": self.total,
            "message": message,
            "error": error,
            "query": self.query,
            "discoveredUrls": self.discovered_urls,
            "pid": os.getpid(),
            "updatedAt": datetime.now(UTC).isoformat(),
        }
        temporary_path = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            temporary_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            temporary_path.replace(self.path)
        finally:
            temporary_path.unlink(missing_ok=True)


def create_graph(
    urls: list[str], api_key: str, query: str = ""
) -> SmartScraperMultiGraph:
    prompt = EXTRACTION_PROMPT
    if query:
        prompt = f"""
The lead discovery query is: {query!r}.
Extract businesses on the supplied page that clearly match that business type
and location. A source may be an official business website or a directory/list
page. For an official site, return that business. For a directory/list, return
the relevant listed businesses and their contact details when shown. Do not
return the directory publisher, blog author, or an unrelated business. Return
an empty `leads` array if the page has no clearly relevant businesses.

For every lead return: business_name, contact_name, email, phone, website,
city, and address. The address should be the full street address (street, area,
and postal/zip code) when published. Use only information found on the page, use
null for unpublished fields, and never guess. Prefer a listed business's
official website; otherwise use the source page URL.
""".strip()
    return SmartScraperMultiGraph(
        prompt=prompt,
        source=urls,
        schema=LeadCollection,
        config={
            "llm": {
                "model": "openai/gpt-4o-mini",
                "api_key": api_key,
                "temperature": 0,
            },
            "headless": True,
            "verbose": True,
        },
    )


def _finish_run(
    args: argparse.Namespace,
    rows: list[dict[str, str]],
    progress: "ProgressReporter",
    activity: "ActivityLogger",
    processed_sources: int,
) -> None:
    """Shared tail for both discovery sources: enrich → save → webhook → done."""
    if not rows:
        activity.log("failed", "No matching leads were extracted")
        raise ValueError(
            "No matching leads were extracted. Try a more specific business type and location."
        )

    # Visit each lead's own website and dig its contact/about pages so that
    # missing emails and phone numbers are filled in from the source site.
    # (Maps leads with no website are simply left as-is here.)
    print(f"Enriching {len(rows)} lead(s) with contact details...", flush=True)
    activity.log("enriching", f"Enriching {len(rows)} lead(s) with contact details")
    rows = enrich_rows_with_contacts(rows, progress=progress, activity=activity)

    write_csv(args.output, rows)

    # Hand the saved leads to the n8n outreach webhook, when configured.
    webhook_url = (args.webhook_url or os.getenv("N8N_WEBHOOK_URL", "")).strip()
    delivery_note = ""
    if webhook_url:
        print(f"Delivering {len(rows)} lead(s) to the outreach webhook...", flush=True)
        activity.log("webhook_sent", f"Sending {len(rows)} lead(s) to the n8n outreach webhook")
        delivered = post_rows_to_webhook(webhook_url, rows)
        delivery_note = f"; {delivered} sent to outreach"
        activity.log("webhook_sent", f"Delivered {delivered} of {len(rows)} lead(s) to n8n")

    progress.total = processed_sources or len(rows)
    progress.completed = progress.total
    progress.update("completed", message=f"Saved {len(rows)} lead(s){delivery_note}")
    activity.log("completed", f"Saved {len(rows)} lead(s) to leads.csv{delivery_note}")
    print(f"Saved {len(rows)} lead(s) to {args.output.expanduser().resolve()}{delivery_note}")


def main() -> int:
    args = parse_args()
    progress = ProgressReporter(args.progress_file, args.job_id)
    activity = ActivityLogger(args.activity_file)
    try:
        query = " ".join((args.query or "").split())
        progress.query = query

        # Google Maps (Places API) discovery is a self-contained branch: it
        # returns finished lead rows (business/phone/website/address), including
        # businesses with no website, then joins the shared enrich → save →
        # webhook path below. It does not use the LLM website scraper at all.
        if query and args.source == "maps":
            maps_key = require_maps_api_key()
            progress.update("discovering", message=f"Searching Google Maps for {query}")
            activity.log("discovering", f"Searching Google Maps for “{query}”")
            print(f"Searching Google Maps for: {query}", flush=True)
            rows = discover_from_places(query, args.max_results, maps_key)
            for row in rows:
                # Enrichment reads _source_url; point it at the site when there is
                # one so we still pull email/extra phone, and log the find.
                row["_source_url"] = row.get("website", "")
                activity.log("lead_found", f"Found lead: {row.get('business_name') or 'a business'}")
            no_site = sum(1 for r in rows if not r.get("website"))
            progress.discovered_urls = [r.get("website") or r.get("business_name", "") for r in rows]
            activity.log(
                "discovering",
                f"Found {len(rows)} business(es) on Google Maps",
                detail=f"{no_site} have no website (call/SMS targets)" if no_site else "all have a website",
            )
            print(
                f"Found {len(rows)} business(es) on Google Maps "
                f"({no_site} without a website).",
                flush=True,
            )
            progress.total = len(rows)
            processed_sources = len(rows)
            # Enrichment is HTML/regex only (no LLM), so no OpenAI key is needed
            # for the Maps path.
            rows = deduplicate_leads(rows)[: args.max_results]
            _finish_run(args, rows, progress, activity, processed_sources)
            return 0

        api_key = require_api_key()
        if query:
            progress.update(
                "discovering",
                message=f"Searching the web for {query}",
            )
            activity.log("discovering", f"Searching the web for “{query}”")
            print(f"Discovering websites for: {query}", flush=True)
            # Search results are candidate sources, not guaranteed leads. Pull
            # a larger pool and keep checking it until the requested lead target
            # has actually been reached (or the candidate pool is exhausted).
            candidate_limit = min(100, max(12, args.max_results * 4))
            urls = discover_urls(query, candidate_limit)
            if args.discovered_output:
                write_url_list(args.discovered_output, urls)
            progress.discovered_urls = urls
            activity.log(
                "discovering",
                f"Found {len(urls)} candidate website(s)",
                detail=f"Checking sources until {args.max_results} lead(s) are found",
            )
            print(
                f"Discovered {len(urls)} candidate website(s); "
                f"targeting {args.max_results} lead(s).",
                flush=True,
            )
        else:
            urls = load_urls(args.urls.expanduser().resolve())
            progress.discovered_urls = urls
        print(f"Scraping {len(urls)} URL(s) with gpt-4o-mini...")
        progress.total = len(urls)
        progress.update("running", message="Preparing the scraper")

        processed_sources = 0
        if query or progress.path:
            rows: list[dict[str, str]] = []
            for index, url in enumerate(urls):
                progress.completed = index
                progress.update(
                    "running",
                    current_url=url,
                    message=f"Scraping {index + 1} of {len(urls)}",
                )
                print(f"[{index + 1}/{len(urls)}] Processing {url}", flush=True)
                activity.log("scraping", f"Scraping {url}", detail=f"{index + 1} of {len(urls)}")
                # A single unreachable or unparseable URL must not abort the run
                # and lose every good lead already collected. In discovery mode
                # we skip the failing source and keep going.
                try:
                    new_rows = unpack_leads(
                        create_graph([url], api_key, query).run(),
                        allow_empty=bool(query),
                    )
                    for row in new_rows:
                        row["_source_url"] = url
                    rows.extend(new_rows)
                    for row in new_rows:
                        name = row.get("business_name") or url
                        activity.log("lead_found", f"Found lead: {name}")
                except Exception as exc:  # noqa: BLE001 - keep the batch alive
                    if not query:
                        raise
                    print(f"    ⚠ Skipping {url}: {exc}", flush=True)
                    activity.log("scraping", f"Skipped {url}", detail=str(exc))
                progress.completed = index + 1
                processed_sources = index + 1
                if query and len(deduplicate_leads(rows)) >= args.max_results:
                    activity.log(
                        "scraping",
                        f"Reached the target of {args.max_results} lead(s)",
                        detail=f"Checked {processed_sources} of {len(urls)} candidate sources",
                    )
                    break
        else:
            rows = unpack_leads(create_graph(urls, api_key, query).run())
            for row in rows:
                row["_source_url"] = row.get("website", "")
            for row in rows:
                name = row.get("business_name") or "a lead"
                activity.log("lead_found", f"Found lead: {name}")

        rows = deduplicate_leads(rows)
        if query:
            rows = rows[: args.max_results]
        _finish_run(args, rows, progress, activity, processed_sources or len(urls))
        return 0
    except KeyboardInterrupt:
        progress.update("failed", message="Scrape cancelled", error="Scrape cancelled")
        activity.log("failed", "Scrape cancelled")
        print("\nScrape cancelled.", file=sys.stderr)
        return 130
    except Exception as exc:
        progress.update("failed", message="The scrape could not be completed", error=str(exc))
        activity.log("failed", "The scrape could not be completed", detail=str(exc))
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
