#!/usr/bin/env python3
"""Find business leads (web search + Crawl4AI, or Google Maps) and extract their contacts."""

from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import html as html_lib
import json
import os
import re
import sqlite3
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent
CSV_FIELDS = (
    "business_name",
    "contact_name",
    "email",
    "phone",
    "website",
    "city",
    "address",
    "store_type",
    # Map position (from Google Maps when known; the dashboard geocodes the rest).
    "lat",
    "lng",
)

BLOCKED_DISCOVERY_DOMAINS = {
    # News, finance, reference — never a business's own site.
    "bbc.co.uk",
    "bbc.com",
    "bloomberg.com",
    "businessinsider.com",
    "cnbc.com",
    "cnn.com",
    "forbes.com",
    "investing.com",
    "livemint.com",
    "marketwatch.com",
    "medium.com",
    "moomoo.com",
    "msn.com",
    "nytimes.com",
    "polymarket.com",
    "reuters.com",
    "theguardian.com",
    "tradingeconomics.com",
    "wikihow.com",
    "grokipedia.com",
    "airbnb.com",
    "tripsavvy.com",
    "tradingview.com",
    "wsj.com",
    "yahoo.com",
    # Marketplaces, job boards, listing/data sites.
    "amazon.com",
    "bbb.org",
    "crunchbase.com",
    "ebay.com",
    "foursquare.com",
    "glassdoor.com",
    "indeed.com",
    "manta.com",
    "mapquest.com",
    "pinterest.com",
    "zoominfo.com",
    # Search engines and social networks.
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
    # Business directories / review aggregators: their pages list businesses,
    # they are never one themselves. The crawler harvests their outbound links.
    "bestinhood.com",
    "canpages.ca",
    "clinicfinder.ca",
    "cylex-canada.ca",
    "cylex.us.com",
    "dentistsranked.com",
    "denzy.ai",
    "findstorenearme.us",
    "firmania.co.uk",
    "fyple.ca",
    "fyple.com",
    "gethuman.com",
    "goodcaring.ca",
    "gumtree.com",
    "hellodent.com",
    "misterwhat.co.uk",
    "misterwhat.com",
    "mystore411.com",
    "opencare.com",
    "qdexx.com",
    "storeshours.com",
    "supermarketlocationmaps.com",
    "thebesttoronto.com",
    "threebestrated.ca",
    "threebestrated.com",
    "toptenrated.ca",
    "torontobestrated.com",
    "whatclinic.com",
    "yelp.ca",
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


def _trim_phone(candidate: str) -> str:
    """Cut text-matching debris off a phone number: "19 (647) 490-8391" →
    "(647) 490-8391", "(647)-479-3010 (647" → "(647)-479-3010"."""
    if candidate.startswith("+"):
        return candidate
    # Leading stray digits before a parenthesised area code ("8 (416) …").
    leading = re.match(r"^(\d{1,2})\s*(?=\(\d{2,4}\))", candidate)
    if leading and leading.group(1) != "1":
        candidate = candidate[leading.end():]
    if len(re.sub(r"\D", "", candidate)) <= 11:
        return candidate
    # Trailing fragments after a complete number ("416-485-5001 416-48").
    count = 0
    for group in re.finditer(r"\d+", candidate):
        count += len(group.group())
        if count >= 10 and len(group.group()) >= 3:
            return candidate[: group.end()]
    return candidate


def _clean_phone(raw: str, *, from_tel_link: bool = False) -> str:
    """Normalize whitespace and reject strings that are not phone-like.

    ``tel:`` link values are trusted with a looser check; free-text matches must
    look unmistakably like a phone number (international ``+`` prefix, a
    parenthesised area code, or at least 10 digits) so that ids, years, and
    price fragments such as ``84-72503`` or ``1910-1930`` are rejected.
    """
    candidate = _trim_phone(" ".join(unquote(raw).split()).strip(" .-"))
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
    # "24 25 26 27 28" (day numbers, counters): a real number has a group of 3+.
    if max(len(g) for g in groups) < 3:
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


# Capitalised two-word phrases that are common on sites but are not people.
NON_NAME_PHRASES = frozenset(
    {
        "contact us", "about us", "sale now", "shop now", "buy now", "read more",
        "learn more", "our team", "our story", "get started", "sign up", "log in",
        "home page", "privacy policy", "terms conditions", "customer service",
        "opening hours", "free shipping", "gift cards", "new arrivals",
    }
)


def _clean_person_name(value: Any) -> str:
    """Accept a value only if it looks like a real person's name."""
    if isinstance(value, dict):
        value = value.get("name") or ""
    name = " ".join(str(value or "").split()).strip()
    # Two-to-four words, each starting with a capital, letters/hyphens/
    # apostrophes/periods only. Rejects single words, digits, and symbols.
    if not re.fullmatch(r"[A-Z][A-Za-z.'\-]+(?: [A-Z][A-Za-z.'\-]+){1,3}", name):
        return ""
    # Reject all-caps slogans (real names are not usually fully upper-cased) and
    # common non-name UI phrases.
    if name.isupper():
        return ""
    if name.lower() in NON_NAME_PHRASES:
        return ""
    return name


# schema.org keys that carry a person tied to the organisation.
PERSON_JSONLD_KEYS = ("founder", "employee", "author", "owner", "member")


def _names_from_jsonld(soup: BeautifulSoup) -> list[str]:
    """Read likely owner/contact person names from schema.org JSON-LD blocks."""
    names: list[str] = []

    def _add(value: Any) -> None:
        cleaned = _clean_person_name(value)
        if cleaned and cleaned not in names:
            names.append(cleaned)

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            node_type = str(node.get("@type", "")).lower()
            if node_type == "person" and node.get("name"):
                _add(node.get("name"))
            for person_key in PERSON_JSONLD_KEYS:
                if person_key in node:
                    target = node[person_key]
                    for item in target if isinstance(target, list) else [target]:
                        _add(item)
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
    return names


def _extract_contacts_from_html(
    html: str,
) -> tuple[list[str], list[str], list[str], list[str]]:
    """Pull emails, phones, addresses, and person names out of a page's HTML."""
    soup = BeautifulSoup(html, "html.parser")

    emails: list[str] = []
    phones: list[str] = []
    addresses: list[str] = []
    names: list[str] = []

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

    # Names: only from structured, high-precision sources — schema.org Person
    # data and itemprop="name" inside a Person scope — to avoid picking random
    # capitalised words out of body copy.
    for name in _names_from_jsonld(soup):
        if name not in names:
            names.append(name)
    for tag in soup.find_all(attrs={"itemprop": "name"}):
        parent_type = " ".join(
            str(tag.find_parent(attrs={"itemtype": True}).get("itemtype", ""))
            if tag.find_parent(attrs={"itemtype": True})
            else ""
        ).lower()
        if "person" in parent_type:
            cleaned = _clean_person_name(tag.get_text(" ", strip=True))
            if cleaned and cleaned not in names:
                names.append(cleaned)

    return emails, phones, addresses, names


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
) -> tuple[str, str, str, str, str]:
    """Inspect a lead's source page, official site, and contact/about pages.

    Returns ``(email, phone, address, official_url, contact_name)``. When
    ``browser`` is supplied, pages are rendered so JavaScript-only contact data
    can be read. ``contact_name`` is only filled from structured Person markup.
    """
    website = _normalized_web_url(row.get("website", ""))
    source_url = _normalized_web_url(row.get("_source_url", ""))
    seeds = [url for url in (source_url, website) if url]
    if not seeds:
        return "", "", "", "", ""

    session = requests.Session()
    session.headers.update({"User-Agent": CONTACT_USER_AGENT})
    queue = list(dict.fromkeys(seeds))
    queued = {url.rstrip("/").lower() for url in queue}
    visited: set[str] = set()
    emails: list[str] = []
    phones: list[str] = []
    addresses: list[str] = []
    names: list[str] = []
    official_url = website if website and not _is_directory_url(website) else ""
    business_name = row.get("business_name", "")

    def merge(found: tuple[list[str], list[str], list[str], list[str]]) -> None:
        found_emails, found_phones, found_addresses, found_names = found
        for email in found_emails:
            if email.lower() not in {item.lower() for item in emails}:
                emails.append(email)
        for phone in found_phones:
            if phone not in phones:
                phones.append(phone)
        for address in found_addresses:
            if address.lower() not in {item.lower() for item in addresses}:
                addresses.append(address)
        for name in found_names:
            if name.lower() not in {item.lower() for item in names}:
                names.append(name)

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
        names[0] if names else "",
    )


def scrape_website_contacts(website: str) -> tuple[str, str, str]:
    """Backward-compatible helper for scraping one website deeply."""
    email, phone, address, _, _ = scrape_lead_contacts({"website": website})
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
        row: dict[str, str], details: tuple[str, str, str, str, str]
    ) -> None:
        email, phone, address, official_url, contact_name = details
        if email and not row.get("email", "").strip():
            row["email"] = email
        if phone and not row.get("phone", "").strip():
            row["phone"] = phone
        if address and not row.get("address", "").strip():
            row["address"] = address
        if contact_name and not row.get("contact_name", "").strip():
            row["contact_name"] = contact_name
        if official_url and (
            not row.get("website", "").strip()
            or _is_directory_url(row.get("website", ""))
        ):
            row["website"] = official_url

    try:
        for index, row in enumerate(rows):
            if row.get("_crawled"):
                continue
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
                for label in ("contact_name", "email", "phone", "address")
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
        row.pop("_crawled", None)
    return rows


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
        choices=("web", "maps", "stores"),
        default="web",
        help=(
            "lead discovery source in query mode: 'web' scrapes official websites "
            "(default), 'maps' pulls businesses from Google Maps (Places API) — "
            "including ones with no website"
        ),
    )
    parser.add_argument(
        "--store-types",
        default="",
        help=f"stores source: comma-separated store types ({', '.join(STORE_TYPES)})",
    )
    parser.add_argument(
        "--locations",
        default="",
        help='stores source: locations separated by "|" (e.g. "Edison, NJ|Newark, NJ")',
    )
    parser.add_argument(
        "--independent-only",
        action="store_true",
        help="stores source: drop national/regional chains (they buy through head office)",
    )
    parser.add_argument(
        "--max-requests",
        type=int,
        default=40,
        help="stores source: hard cap on Google Maps requests per run (default: 40)",
    )
    parser.add_argument(
        "--zip-radius",
        type=float,
        default=5.0,
        help="stores source: miles around each ZIP location to search (0 = only inside the ZIP)",
    )
    parser.add_argument(
        "--no-outreach",
        action="store_true",
        help="save leads but don't send them to the outreach webhook (no automatic calls)",
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
    "places.location,"
    "nextPageToken"
)


def _places_coords(place: dict[str, Any]) -> tuple[str, str]:
    """(lat, lng) strings from a place's location, or ("", "")."""
    location = place.get("location") or {}
    try:
        return f"{float(location['latitude']):.6f}", f"{float(location['longitude']):.6f}"
    except (KeyError, TypeError, ValueError):
        return "", ""


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


# --- Store Finder ----------------------------------------------------------
#
# Finds retail buyers for a wholesale supplier (Cotton Valley / Universal
# Distribution sell household goods, disposables, health & beauty… to stores).
# Google Maps is searched for every chosen store type in every chosen location,
# round-robin so no single combination eats the budget. National chains are
# dropped by default: they buy through head-office procurement, so the local
# store can't place a wholesale order — independent owners can.
#
# Keep the keys in step with lib/store-types.ts (the dashboard's catalog).

STORE_TYPES_PATH = BASE_DIR / "store-types.json"
CUSTOM_STORE_TYPES_PATH = BASE_DIR / "data" / "store-types.json"
# Custom store types have no Google place-type allow-list, so instead they
# drop listings whose main type is plainly not a retail buyer.
NON_RETAIL_PLACE_TYPES = frozenset(
    {
        "bank", "atm", "finance", "accounting", "insurance_agency", "lawyer", "real_estate_agency",
        "school", "primary_school", "secondary_school", "university", "library", "church", "mosque",
        "synagogue", "hindu_temple", "place_of_worship", "hospital", "doctor", "dentist",
        "physiotherapist", "medical_lab", "veterinary_care", "lodging", "hotel", "motel",
        "parking", "car_repair", "car_wash", "car_dealer", "local_government_office",
        "city_hall", "courthouse", "police", "fire_station", "post_office", "embassy",
        "park", "tourist_attraction", "museum", "gym", "hair_care", "beauty_salon", "nail_salon",
        "spa", "moving_company", "storage", "travel_agency", "apartment_building",
    }
)


def load_store_types(custom_path: Path = CUSTOM_STORE_TYPES_PATH) -> dict[str, dict[str, Any]]:
    """Built-in store types (store-types.json, shared with the dashboard) plus
    the user's own from data/store-types.json (added on the dashboard). Hidden
    built-ins stay valid here — hiding only removes them from the picker."""
    catalog = json.loads(STORE_TYPES_PATH.read_text(encoding="utf-8"))
    types: dict[str, dict[str, Any]] = {
        item["key"]: {
            "label": item["singular"],
            "plural": item["plural"],
            "queries": tuple(item["queries"]),
            "types": set(item.get("googleTypes", [])),
            "keywords": tuple(item.get("keywords", [])),
            "custom": False,
        }
        for item in catalog["types"]
    }
    try:
        saved = json.loads(custom_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        saved = {}
    for item in saved.get("custom", []) if isinstance(saved, dict) else []:
        queries = tuple(str(query) for query in item.get("queries", []) if str(query).strip())
        if not item.get("key") or not queries:
            continue
        types[item["key"]] = {
            "label": item.get("singular") or item.get("label") or item["key"],
            "plural": item.get("label") or item["key"],
            "queries": queries,
            "types": set(),
            "keywords": (),
            "custom": True,
        }
    return types


STORE_TYPES = load_store_types()

# National / regional chains (normalized: lowercase, "&" → "and", punctuation
# stripped). Matched as whole words anywhere in the store name.
CHAIN_NAMES = (
    "walmart", "target", "costco", "sams club", "bjs wholesale", "kmart", "sears", "macys", "kohls",
    "jcpenney", "dollar tree", "dollar general", "family dollar", "five below", "big lots", "ollies",
    "99 cents only", "dollarama", "kroger", "safeway", "albertsons", "shoprite", "stop and shop",
    "acme markets", "aldi", "lidl", "whole foods", "trader joes", "publix", "wegmans", "food lion",
    "giant food", "giant eagle", "heb", "meijer", "save a lot", "foodtown", "price rite", "pricerite",
    "sprouts", "the fresh market", "harris teeter", "winn dixie", "hannaford", "weis markets",
    "h mart", "hmart", "lotte plaza", "99 ranch", "ranch 99", "patel brothers", "patel bros", "seafood city",
    "mitsuwa", "uwajimaya", "food bazaar", "western beef", "fairway market", "stew leonards",
    "kings food", "sedanos", "fiesta mart", "el super", "vallarta", "cardenas", "northgate market",
    "smart and final", "grocery outlet", "food 4 less", "piggly wiggly", "ingles", "bilo",
    "cvs", "walgreens", "rite aid", "duane reade", "7 eleven", "wawa", "quickchek", "circle k",
    "speedway", "sheetz", "cumberland farms", "royal farms", "home depot", "lowes", "ace hardware",
    "true value", "homegoods", "tj maxx", "marshalls", "ross dress for less", "burlington",
    "bed bath", "staples", "michaels", "party city", "at home", "christmas tree shops",
    "mcdonalds", "burger king", "wendys", "subway", "dunkin", "starbucks", "dominos", "pizza hut",
    "papa johns", "taco bell", "kfc", "chipotle", "jersey mikes", "jimmy johns", "panera",
)
CHAIN_RE = re.compile(r"\b(?:" + "|".join(re.escape(name) for name in CHAIN_NAMES) + r")\b")
# A name seen this many times across one run's results is a chain we don't list.
CHAIN_REPEAT_THRESHOLD = 3
# Places API Text Search (New) with phone/website/rating fields is billed at the
# Enterprise rate — roughly this much per request. Shown in logs as an estimate.
PLACES_COST_PER_REQUEST = 0.035
STORE_FIELD_MASK = (
    "places.id,"
    "places.displayName,"
    "places.types,"
    "places.primaryType,"
    "places.businessStatus,"
    "places.internationalPhoneNumber,"
    "places.nationalPhoneNumber,"
    "places.websiteUri,"
    "places.formattedAddress,"
    "places.addressComponents,"
    "places.rating,"
    "places.userRatingCount,"
    "places.location,"
    "nextPageToken"
)


# Hosts that are a link, not a store's own website (left blank instead).
NOT_A_WEBSITE_HOSTS = ("drive.google.com", "docs.google.com", "sites.google.com", "business.site", "linktr.ee", "g.page", "goo.gl")


def _clean_store_website(url: str) -> str:
    """Drop tracking query strings ("?utm_source=…_gmb") and links that aren't a
    website (Google Drive, social pages) from a Maps listing's website."""
    url = _normalized_web_url(url)
    if not url:
        return ""
    host = _hostname(url)
    labels = host.split(".")
    if any(host == bad or host.endswith(f".{bad}") for bad in NOT_A_WEBSITE_HOSTS) or any(
        label in SOCIAL_HOST_LABELS for label in labels[:-1]
    ):
        return ""
    return urlunparse(urlparse(url)._replace(query="", fragment=""))


def _clean_store_name(name: str, website: str) -> str:
    """"Desi Fresh - Indian Grocery Delivery to your door steps - ORDER ONLINE"
    → "Desi Fresh". Short names with a dash ("Joe's - Deli") are left alone."""
    name = " ".join(name.split())
    if len(name) > 32 and re.search(r"\s[|\-–—:]\s", name):
        return _tidy_business_name(name, website or "https://unknown.invalid/")
    return name


def _store_name_key(name: str) -> str:
    lowered = name.lower().replace("&", " and ").replace("'", "")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", lowered).split())


def is_chain_store(name: str) -> bool:
    return bool(CHAIN_RE.search(_store_name_key(name)))


def _place_fits_store_type(place: dict[str, Any], store_type: dict[str, Any]) -> bool:
    """Google's place types, or failing that the name, must fit the category —
    a "dollar store" search also returns banks and nail salons nearby."""
    if store_type.get("custom"):
        # Trust Google's relevance for user-defined types; only drop listings
        # that are plainly not shops (a bank or school next door).
        return (place.get("primaryType") or "") not in NON_RETAIL_PLACE_TYPES
    types = set(place.get("types") or []) | {place.get("primaryType") or ""}
    if types & store_type["types"]:
        return True
    name = _store_name_key((place.get("displayName") or {}).get("text", ""))
    return any(keyword in name for keyword in store_type["keywords"])


def _places_text_search(
    text_query: str, api_key: str, page_token: str = "", *, restriction: dict[str, Any] | None = None
) -> dict[str, Any]:
    payload: dict[str, Any] = {"textQuery": text_query, "pageSize": 20}
    if restriction:
        payload["locationRestriction"] = restriction
    if page_token:
        payload["pageToken"] = page_token
    try:
        response = requests.post(
            PLACES_TEXT_SEARCH_URL,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": api_key,
                "X-Goog-FieldMask": STORE_FIELD_MASK,
            },
            timeout=20,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        detail = ""
        if getattr(exc, "response", None) is not None:
            detail = f" (HTTP {exc.response.status_code}: {exc.response.text[:200]})"
        raise ValueError(f"Google Places request failed{detail}") from exc
    return response.json()


def parse_store_types(value: str) -> list[str]:
    keys = [key.strip() for key in (value or "").split(",") if key.strip()]
    unknown = [key for key in keys if key not in STORE_TYPES]
    if unknown:
        raise ValueError(f"Unknown store type(s): {', '.join(unknown)}. Choose from: {', '.join(STORE_TYPES)}")
    if not keys:
        raise ValueError("Choose at least one store type.")
    return list(dict.fromkeys(keys))


# A ZIP location as sent by the dashboard: "08817@40.513664,-74.405676"
# (the dashboard resolves the ZIP's centre); a bare "08817" also works but is
# searched as text, without the area restriction.
ZIP_LOCATION_RE = re.compile(r"^(\d{5})@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$")
# "Only this ZIP" still searches a box around its centre (ZIPs vary in size),
# then keeps only stores whose address carries the ZIP.
ZIP_ONLY_SEARCH_MILES = 4.0


def parse_zip_location(location: str) -> tuple[str, float, float] | None:
    match = ZIP_LOCATION_RE.match(location.strip())
    return (match.group(1), float(match.group(2)), float(match.group(3))) if match else None


def location_display(location: str) -> str:
    zip_area = parse_zip_location(location)
    return f"ZIP {zip_area[0]}" if zip_area else location


def _miles_between(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    import math

    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((phi2 - phi1) / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    )
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def _area_rectangle(lat: float, lng: float, miles: float) -> dict[str, Any]:
    """Places API locationRestriction: a box reaching ``miles`` from a point."""
    import math

    dlat = miles / 69.0
    dlng = miles / (69.0 * max(0.2, math.cos(math.radians(lat))))
    return {
        "rectangle": {
            "low": {"latitude": lat - dlat, "longitude": lng - dlng},
            "high": {"latitude": lat + dlat, "longitude": lng + dlng},
        }
    }


def _place_postal_code(place: dict[str, Any]) -> str:
    for component in place.get("addressComponents", []):
        if "postal_code" in component.get("types", []):
            return (component.get("longText") or component.get("shortText") or "").strip()
    return ""


def parse_locations(value: str) -> list[str]:
    locations = [" ".join(part.split()) for part in (value or "").split("|")]
    locations = list(dict.fromkeys(location for location in locations if len(location) >= 2))
    if not locations:
        raise ValueError("Add at least one location (e.g. Edison, NJ).")
    return locations


def store_search_label(store_keys: list[str], locations: list[str]) -> str:
    types = ", ".join(STORE_TYPES[key]["plural"] for key in store_keys[:3])
    if len(store_keys) > 3:
        types += f" +{len(store_keys) - 3}"
    shown = [location_display(location) for location in locations]
    places = "; ".join(shown[:2]) + (f" +{len(shown) - 2}" if len(shown) > 2 else "")
    return f"{types} in {places}"


# Remembers, across runs, how far each Google Maps search has been paged and
# which places were already handed out as leads, so searching the same area
# again continues with the next results instead of starting over. The
# dashboard reads and clears it too (lib/store-search-memory.ts).
SEARCH_MEMORY_PATH = BASE_DIR / "data" / "store-search.db"
SEARCH_MEMORY_SCHEMA = """
CREATE TABLE IF NOT EXISTS searches (
    search_key TEXT PRIMARY KEY,
    location TEXT NOT NULL,
    store_key TEXT NOT NULL,
    label TEXT NOT NULL,
    next_token TEXT NOT NULL DEFAULT '',
    pages INTEGER NOT NULL DEFAULT 0,
    exhausted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS searches_location ON searches (location);
CREATE TABLE IF NOT EXISTS places (
    place_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    found_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS places_location ON places (location);
"""
# Once every search for a ZIP is used up, its area is split into 2×2, then
# 4×4 tiles: Google caps each search at 60 results, so smaller areas surface
# stores the wide search never reached.
MAX_TILE_LEVEL = 2


def memory_location_key(location: str) -> str:
    """"08817@40.51,-74.40" → "08817"; "Edison,  NJ" → "edison, nj"."""
    zip_area = parse_zip_location(location)
    return zip_area[0] if zip_area else " ".join(location.split()).lower()


class StoreSearchMemory:
    """Search progress and found places, in SQLite. Changes are held until
    ``commit()``, which runs only once a run's leads are saved — a cancelled
    or failed run leaves the memory as it was, so its stores come back."""

    def __init__(self, path: Path = SEARCH_MEMORY_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=10)
        self.db.executescript(SEARCH_MEMORY_SCHEMA)
        self.found_ids = {place_id for (place_id,) in self.db.execute("SELECT place_id FROM places")}
        self._searches: dict[str, tuple[str, str, str, str, int, int]] = {}
        self._places: dict[str, tuple[str, str]] = {}

    def search_state(self, key: str) -> tuple[str, int, bool] | None:
        """(next page token, pages fetched, used up) for a search, if it ran before."""
        row = self.db.execute(
            "SELECT next_token, pages, exhausted FROM searches WHERE search_key = ?", (key,)
        ).fetchone()
        return (row[0], row[1], bool(row[2])) if row else None

    def record_search(
        self, key: str, location: str, store_key: str, label: str, token: str, pages: int, exhausted: bool
    ) -> None:
        self._searches[key] = (location, store_key, label, token, pages, int(exhausted))

    def record_place(self, place_id: str, name: str, location: str) -> None:
        self._places[place_id] = (name, location)

    def commit(self) -> None:
        now = datetime.now(UTC).isoformat()
        with self.db:
            self.db.executemany(
                "INSERT OR REPLACE INTO searches VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [(key, *values, now) for key, values in self._searches.items()],
            )
            self.db.executemany(
                "INSERT OR IGNORE INTO places VALUES (?, ?, ?, ?)",
                [(place_id, name, location, now) for place_id, (name, location) in self._places.items()],
            )
        self._searches.clear()
        self._places.clear()

    def close(self) -> None:
        self.db.close()


def phone_key(phone: str) -> str:
    """Last 10 digits, so "+1 609-426-4444" and "(609) 426-4444" match."""
    return re.sub(r"\D", "", phone or "")[-10:]


def _search_key(store_key: str, text: str, restriction: dict[str, Any] | None) -> str:
    raw = json.dumps([store_key, text, restriction], sort_keys=True)
    return hashlib.sha1(raw.encode()).hexdigest()


def _split_rectangle(restriction: dict[str, Any], parts: int) -> list[dict[str, Any]]:
    low, high = restriction["rectangle"]["low"], restriction["rectangle"]["high"]
    lat_step = (high["latitude"] - low["latitude"]) / parts
    lng_step = (high["longitude"] - low["longitude"]) / parts
    return [
        {
            "rectangle": {
                "low": {"latitude": low["latitude"] + row * lat_step, "longitude": low["longitude"] + col * lng_step},
                "high": {
                    "latitude": low["latitude"] + (row + 1) * lat_step,
                    "longitude": low["longitude"] + (col + 1) * lng_step,
                },
            }
        }
        for row in range(parts)
        for col in range(parts)
    ]


def discover_stores(
    store_keys: list[str],
    locations: list[str],
    target: int,
    api_key: str,
    *,
    independent_only: bool,
    max_requests: int,
    erp: "ErpNextSync | None",
    progress: "ProgressReporter",
    activity: "ActivityLogger",
    zip_radius_miles: float = 5.0,
    memory: StoreSearchMemory | None = None,
) -> tuple[list[dict[str, str]], str]:
    """Search Google Maps for every (store type × location × phrasing) until
    ``target`` usable stores are collected or ``max_requests`` is spent.

    Rows come back already filtered: open, contactable, the right kind of
    store, not a chain (when ``independent_only``), not already in ERPNext,
    and not handed out by an earlier run (``memory``). Searches an earlier run
    started continue from the page it reached.

    Returns (rows, why fewer than ``target`` were found — "" if none short).
    """
    most_phrases = max(len(STORE_TYPES[key]["queries"]) for key in store_keys)
    resumed = 0

    def combos_for(level: int) -> list[dict[str, Any]]:
        """Level 0: each type's main phrase in every location first, then the
        alternates, so a small budget still covers every type and place.
        Level n: every ZIP search again over 2ⁿ × 2ⁿ tiles of its area."""
        nonlocal resumed
        built: list[dict[str, Any]] = []
        for index in range(most_phrases):
            for location in locations:
                zip_area = parse_zip_location(location)
                if level and not zip_area:
                    continue
                for key in store_keys:
                    if index >= len(STORE_TYPES[key]["queries"]):
                        continue
                    phrase = STORE_TYPES[key]["queries"][index]
                    base: dict[str, Any] = {
                        "store_key": key,
                        "location": memory_location_key(location),
                        "token": "",
                        "pages": 0,
                        "done": False,
                        "resumed": False,
                        "zip": None,
                    }
                    variants: list[dict[str, Any]] = []
                    if zip_area:
                        # ZIP search: Google is restricted to the area, then results
                        # are filtered to the ZIP itself or the chosen radius.
                        zip_code, lat, lng = zip_area
                        miles = zip_radius_miles if zip_radius_miles > 0 else ZIP_ONLY_SEARCH_MILES
                        area = _area_rectangle(lat, lng, miles)
                        tiles = _split_rectangle(area, 2**level) if level else [area]
                        for number, tile in enumerate(tiles, 1):
                            variants.append(
                                dict(
                                    base,
                                    # "Only inside the ZIP": naming the ZIP makes Google rank
                                    # stores with that postcode first inside the search box.
                                    text=f"{phrase} {zip_code}" if zip_radius_miles <= 0 else phrase,
                                    label=f"{phrase} near {zip_code}"
                                    + (f" (area {number} of {len(tiles)})" if level else ""),
                                    restriction=tile,
                                    zip={"code": zip_code, "lat": lat, "lng": lng},
                                )
                            )
                    else:
                        variants.append(
                            dict(base, text=f"{phrase} in {location}", label=f"{phrase} in {location}", restriction=None)
                        )
                    for combo in variants:
                        combo["key"] = _search_key(key, combo["text"], combo["restriction"])
                        saved = memory.search_state(combo["key"]) if memory else None
                        if saved:
                            token, pages, exhausted = saved
                            combo.update(token=token, pages=pages, done=exhausted, resumed=bool(token))
                            resumed += int(pages > 0 and not exhausted)
                        built.append(combo)
        return built

    level = 0
    combos = combos_for(level)
    has_zip = any(parse_zip_location(location) for location in locations)

    rows: list[dict[str, str]] = []
    seen_ids: set[str] = set(memory.found_ids) if memory else set()
    name_counts: dict[str, int] = {}
    dropped = {
        "chain": 0, "off_type": 0, "closed": 0, "no_contact": 0, "in_erp": 0, "outside_zip": 0, "found_before": 0,
        "same_phone": 0,
    }
    # Listings sharing a phone (a chain's central line, one shop listed twice)
    # are one lead: the dashboard merges them and a call reaches both.
    taken_phones: set[str] = set()
    requests_made = 0

    def accept(row: dict[str, str]) -> None:
        if erp is not None and erp.skip_existing:
            reason = erp.match(row)
            if reason:
                dropped["in_erp"] += 1
                erp.skipped += 1
                activity.log("erpnext", f"Skipped {row['business_name']} — already in ERP", detail=f"Matched on {reason}")
                return
        rows.append(row)
        if phone_key(row["phone"]):
            taken_phones.add(phone_key(row["phone"]))
        activity.log(
            "lead_found",
            f"Found {row['store_type'].lower()}: {row['business_name']}",
            detail=", ".join(filter(None, [row["city"], row["phone"], "website" if row["website"] else "no website"])),
        )

    if resumed:
        activity.log(
            "discovering",
            f"Continuing {resumed} search(es) from where earlier runs stopped",
            detail=f"{len(seen_ids)} store(s) found before will be skipped",
        )

    used_up = False
    while len(rows) < target and requests_made < max_requests:
        active = [combo for combo in combos if not combo["done"]]
        while not active and has_zip and level < MAX_TILE_LEVEL:
            level += 1
            combos = combos_for(level)
            active = [combo for combo in combos if not combo["done"]]
            if active:
                activity.log(
                    "discovering",
                    f"Searching each ZIP area as {4**level} smaller areas",
                    detail="The wider searches are used up; smaller areas surface stores they never reached",
                )
        if not active:
            used_up = True
            break
        for combo in active:
            if len(rows) >= target or requests_made >= max_requests:
                break
            store_type = STORE_TYPES[combo["store_key"]]
            progress.update(
                "discovering",
                message=f"Searching Google Maps: {combo['label']} ({len(rows)} of {target} stores found)",
            )
            page_token = combo["token"]
            try:
                data = _places_text_search(combo["text"], api_key, page_token, restriction=combo["restriction"])
            except ValueError:
                if not combo["resumed"]:
                    raise
                # The saved page token from an earlier run was rejected (expired):
                # start this search over; stores already found are skipped.
                requests_made += 1
                page_token = ""
                combo.update(token="", pages=0, resumed=False)
                data = _places_text_search(combo["text"], api_key, restriction=combo["restriction"])
            requests_made += 1
            combo["token"] = data.get("nextPageToken", "")
            combo["pages"] += 1
            combo["done"] = not combo["token"]

            read_whole_page = True
            for place in data.get("places", []):
                if len(rows) >= target:
                    read_whole_page = False
                    break
                place_id = place.get("id") or ""
                if not place_id:
                    continue
                if place_id in seen_ids:
                    if memory and place_id in memory.found_ids:
                        dropped["found_before"] += 1
                    continue
                seen_ids.add(place_id)
                website = _clean_store_website(place.get("websiteUri", ""))
                name = _clean_store_name((place.get("displayName") or {}).get("text", ""), website)
                phone = (place.get("internationalPhoneNumber") or place.get("nationalPhoneNumber") or "").strip()
                if place.get("businessStatus") not in (None, "", "OPERATIONAL"):
                    dropped["closed"] += 1
                    continue
                if not name or not (phone or website):
                    dropped["no_contact"] += 1
                    continue
                if phone_key(phone) in taken_phones:
                    dropped["same_phone"] += 1
                    continue
                if combo["zip"] is not None:
                    area = combo["zip"]
                    location = place.get("location") or {}
                    if zip_radius_miles > 0:
                        try:
                            inside = (
                                _miles_between(area["lat"], area["lng"], float(location["latitude"]), float(location["longitude"]))
                                <= zip_radius_miles
                            )
                        except (KeyError, TypeError, ValueError):
                            inside = False
                    else:
                        inside = _place_postal_code(place) == area["code"]
                    if not inside:
                        dropped["outside_zip"] += 1
                        continue
                if not _place_fits_store_type(place, store_type):
                    dropped["off_type"] += 1
                    continue
                key = _store_name_key(name)
                name_counts[key] = name_counts.get(key, 0) + 1
                if independent_only and is_chain_store(name):
                    dropped["chain"] += 1
                    continue
                rating = place.get("rating")
                row = {
                    "business_name": name,
                    "contact_name": "",
                    "email": "",
                    "phone": phone,
                    "website": website,
                    "city": _places_city(place),
                    "address": _clean_address(place.get("formattedAddress", "")),
                    "store_type": store_type["label"],
                    "lat": _places_coords(place)[0],
                    "lng": _places_coords(place)[1],
                    "_source_url": website,
                    "_rating": f"{rating} ({place.get('userRatingCount', 0)} reviews)" if rating else "",
                    "_place_id": place_id,
                    "_memory_location": combo["location"],
                }
                # A name recurring across results is a chain missing from
                # CHAIN_NAMES; stop adding it (earlier copies are retracted below).
                if independent_only and name_counts[key] >= CHAIN_REPEAT_THRESHOLD:
                    continue
                accept(row)

            if memory:
                # A page the target cut short is saved as unread, so the next
                # run reads it again (its stores taken now are skipped then).
                memory.record_search(
                    combo["key"],
                    combo["location"],
                    combo["store_key"],
                    combo["label"],
                    combo["token"] if read_whole_page else page_token,
                    combo["pages"] if read_whole_page else combo["pages"] - 1,
                    combo["done"] and read_whole_page,
                )

    if independent_only:
        # Retract stores whose name turned out to repeat (≥ threshold): chains.
        repeated = {key for key, count in name_counts.items() if count >= CHAIN_REPEAT_THRESHOLD}
        if repeated:
            rows[:] = [row for row in rows if _store_name_key(row["business_name"]) not in repeated]
            dropped["chain"] += sum(name_counts[key] for key in repeated)
            activity.log(
                "discovering",
                f"Dropped {len(repeated)} name(s) that appear at {CHAIN_REPEAT_THRESHOLD}+ locations (chains)",
                detail=", ".join(sorted(repeated)[:8]),
            )

    del rows[target:]
    for row in rows:
        place_id, location = row.pop("_place_id"), row.pop("_memory_location")
        if memory:
            memory.record_place(place_id, row["business_name"], location)
    cost = requests_made * PLACES_COST_PER_REQUEST
    summary = (
        f"{len(rows)} store(s) from {requests_made} Google Maps request(s) (~${cost:.2f}); dropped "
        f"{dropped['chain']} chain, {dropped['off_type']} off-type, {dropped['closed']} closed, "
        f"{dropped['no_contact']} without phone/website, {dropped['in_erp']} already in ERP"
        + (f", {dropped['outside_zip']} outside the ZIP area" if dropped["outside_zip"] else "")
        + (f", {dropped['found_before']} found in earlier searches" if dropped["found_before"] else "")
        + (f", {dropped['same_phone']} sharing another store's phone" if dropped["same_phone"] else "")
    )
    print(summary, flush=True)
    activity.log("discovering", f"Store search finished: {len(rows)} store(s)", detail=summary)
    shortfall = ""
    if len(rows) < target:
        skipped = dropped["in_erp"] + dropped["found_before"]
        if used_up:
            shortfall = (
                "Google Maps has no more new stores for these searches"
                + (f" ({skipped} of its results were stores you already have)" if skipped else "")
                + ". Add more cities/ZIPs or store types, widen the ZIP radius, or start these searches over."
            )
        else:
            shortfall = (
                f"the run stopped at its limit of {max_requests} Google Maps request{'' if max_requests == 1 else 's'}"
                + (f" — {skipped} of the results were stores you already have" if skipped else "")
                + ". Run it again to continue from where it stopped."
            )
        activity.log("discovering", f"Found {len(rows)} of {target} stores", detail=shortfall)
    return rows, shortfall


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
                    "lat": _places_coords(place)[0],
                    "lng": _places_coords(place)[1],
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


NON_BUSINESS_TLDS = (".gov", ".edu", ".mil", ".gov.uk", ".ac.uk", ".gc.ca", ".gov.au", ".gov.pk")
# Paths that never lead to a business (dropped outright).
DEAD_END_PATH_PARTS = (
    "/image", "/photo", "/jobs/", "/careers/", "/wiki/", "/forum", "/press/", "phone-number",
    "newsroom", "news-release", "press-release", "annualreport", "annual-report", "investor",
    "vendor", "supplier", "database", "/symbols/", "/report/", "/pin/create", "/sharer", "/share?", "/intent/",
)
# Subdomains that are a company's PR/investor/jobs/vendor portals, not its storefront.
DEAD_END_SUBDOMAINS = ("newsroom", "news", "press", "media", "investors", "investor", "ir", "careers", "jobs", "vendor", "vendornet", "suppliers", "blog")
# Social networks on any country domain (pinterest.co.uk, facebook.fr…).
SOCIAL_HOST_LABELS = ("pinterest", "facebook", "twitter", "linkedin", "instagram", "reddit", "tiktok", "youtube", "whatsapp", "threads")
# Paths/titles of pages that *list* businesses — a guide, ranking, directory.
# They aren't leads themselves, but the crawler harvests their outbound links
# to the listed businesses' own sites.
LISTING_PATH_PARTS = (
    "/news/", "/blog/", "/article", "/story/", "/stories/", "/guides/", "/guide/",
    "/gallery/", "/page/", "/places/", "/catalog/", "/list", "/city/", "/directory",
    "things-to-do",
)
LISTING_PATH_RE = re.compile(r"(?:^|[/\-_])(?:best|top|largest|biggest|cheapest)[-_]")
LISTING_TITLE_PATTERNS = tuple(
    re.compile(pattern)
    for pattern in (
        r"\b(?:top|best)\s+\d+\b",
        r"\b\d+\s+(?:best|top|great|amazing|largest|biggest|quirkiest)\b",
        r"\bbest\s+[\w' ]{2,40}\s+(?:in|near|of)\b",
        r"\b(?:guide to|things to do|where to|near me|directory)\b",
        r"\blist of\b",
    )
)
# Titles that are never useful: news, finance, lead-list sellers, encyclopedias.
DEAD_END_TITLE_PATTERNS = tuple(
    re.compile(pattern)
    for pattern in (
        r"\b(?:stocks?|stock market|market data|markets today|us markets|forex|prediction markets?)\b",
        r"\b(?:breaking news|latest news)\b",
        r"\b(?:b2b database|email list|mailing list|leads? list|business list)\b",
        r"\b(?:wikipedia|encyclopedia|britannica)\b",
    )
)
QUERY_STOPWORDS = frozenset(
    {"the", "and", "for", "with", "near", "best", "top", "local", "company", "companies", "services", "service", "shop", "shops"}
)


def _query_location_tokens(query: str) -> list[str]:
    parts = re.split(r"\s+in\s+", query, flags=re.IGNORECASE)
    if len(parts) < 2:
        return []
    return [token for token in re.findall(r"[a-z]+", parts[-1].lower()) if len(token) >= 3]


def _query_keywords(query: str) -> tuple[list[str], str]:
    """Business-type tokens of a "<keywords> in <location>" query (stemmed), and
    their joined form ("super market" → "supermarket")."""
    keywords = re.split(r"\s+in\s+", query, flags=re.IGNORECASE)[0]
    tokens = [token for token in re.findall(r"[a-z0-9]+", keywords.lower()) if len(token) >= 3]
    meaningful = [token for token in tokens if token not in QUERY_STOPWORDS] or tokens
    stems = [
        re.sub(r"(?:es|s)$", "", re.sub(r"ies$", "y", token)) if len(token) > 4 else token
        for token in meaningful
    ]
    return stems, "".join(stems) if len(stems) > 1 else ""


def _relevance(stems: list[str], compact: str, haystack: str) -> int:
    score = sum(1 for stem in stems if stem in haystack)
    if compact and compact in re.sub(r"[^a-z0-9]", "", haystack):
        score += len(stems)
    return score


def _is_dead_end_url(url: str) -> bool:
    """URLs that can never be, or lead to, a business site."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return True
    host = _hostname(url)
    path = parsed.path.lower()
    labels = host.split(".")
    return (
        not host
        or is_blocked_discovery_domain(host)
        or (len(labels) > 2 and labels[0] in DEAD_END_SUBDOMAINS)
        or any(label in SOCIAL_HOST_LABELS for label in labels[:-1])
        or host.endswith(NON_BUSINESS_TLDS)
        or path.endswith((".pdf", ".doc", ".docx", ".xls", ".xlsx", ".jpg", ".png"))
        or any(part in path for part in DEAD_END_PATH_PARTS)
    )


def _looks_like_listing_url(url: str, title: str = "", *, strict: bool = False) -> bool:
    """Whether a URL/title looks like a page that lists businesses.

    ``strict`` (used on crawled pages) only trusts the URL and numbered
    rankings: business homepages often have titles like "Best Dentist in
    Toronto", which is fine for ranking search results but not for deciding a
    page isn't a business.
    """
    path = urlparse(url).path.lower()
    lowered = title.lower()
    patterns = LISTING_TITLE_PATTERNS[:2] if strict else LISTING_TITLE_PATTERNS
    return (
        _is_directory_url(url)
        or any(part in path for part in LISTING_PATH_PARTS)
        or bool(LISTING_PATH_RE.search(path))
        or any(pattern.search(lowered) for pattern in patterns)
    )


def discover_urls(query: str, max_results: int) -> list[str]:
    """Find candidate pages for a natural-language lead query.

    One result per site, ranked: pages that look like a business's own site
    first, then listing pages (directories, "best X in Y" guides) whose
    outbound links the crawler harvests. News, finance, government and other
    dead ends are dropped.
    """
    query = " ".join(query.split())
    if len(query) < 3:
        raise ValueError("The search query must contain at least 3 characters.")
    if max_results < 1 or max_results > 100:
        raise ValueError("max-results must be between 1 and 100.")

    from ddgs import DDGS

    per_search = min(50, max(15, max_results * 2))
    raw: list[dict[str, Any]] = []
    errors: list[str] = []
    plain = re.sub(r"\s+in\s+", " ", query, flags=re.IGNORECASE)
    # Yahoo gives the most location-faithful results for local searches (city
    # guides, real businesses); the default engine mix adds a different slice.
    # Bing was tried and skews to off-topic results. Free engines throttle
    # without warning, so fallbacks run whenever the pool is still thin.
    primary = ((query, "yahoo"), (query, "auto"), (f"{query} contact phone address", "yahoo"))
    fallbacks = ((plain, "auto"), (query, "duckduckgo"), (query, "brave"), (plain, "yahoo"))
    with DDGS() as ddgs:
        for index, (search, backend) in enumerate((*primary, *fallbacks)):
            if index >= len(primary) and len({_hostname(str(r.get("href") or "")) for r in raw}) >= max_results * 2:
                break
            try:
                raw.extend(ddgs.text(search, max_results=per_search, backend=backend) or [])
            except Exception as exc:  # noqa: BLE001 - one failed search must not end discovery
                errors.append(str(exc))
    if not raw and errors:
        raise ValueError(f"Web search failed: {errors[0]}")

    stems, compact = _query_keywords(query)
    location_tokens = _query_location_tokens(query)
    ranked: list[tuple[bool, int, int, str]] = []
    seen_hosts: set[str] = set()
    for result in raw:
        href = str(result.get("href") or "")
        if _is_dead_end_url(href):
            continue
        host = _hostname(href)
        if host in seen_hosts:
            continue
        title = str(result.get("title") or "")
        # A pattern that merely repeats the searched business type is fine
        # (e.g. a "stock broker" search may say "stocks").
        if any(
            (match := pattern.search(title.lower())) and not any(stem in match.group(0) for stem in stems)
            for pattern in DEAD_END_TITLE_PATTERNS
        ):
            continue
        path = urlparse(href).path.lower()
        haystack = f"{title.lower()} {str(result.get('body') or '').lower()} {host} {path}"
        score = _relevance(stems, compact, haystack)
        if stems and score == 0:
            continue
        score += sum(1 for token in location_tokens if token in haystack)
        seen_hosts.add(host)
        ranked.append(
            (_looks_like_listing_url(href, title), -score, len(ranked), urlunparse(urlparse(href)._replace(fragment="")))
        )

    # Interleave direct hits with listing pages: local guides/directories
    # carry the best candidates (harvested by the crawler), direct hits are
    # leads in one step.
    ranked.sort()
    direct = [url for is_listing, *_, url in ranked if not is_listing]
    listings = [url for is_listing, *_, url in ranked if is_listing]
    interleaved: list[str] = []
    for index in range(max(len(direct), len(listings))):
        interleaved.extend(group[index] for group in (direct, listings) if index < len(group))
    discovered = interleaved[:max_results]
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


# --- Crawl4AI website crawler ---------------------------------------------
#
# Each candidate site is opened in a real (stealth) Chromium by Crawl4AI,
# together with its homepage and a few contact/about pages. Contacts are read
# straight from the rendered HTML — schema.org data, mailto:/tel: links, page
# text — so no LLM is required. When a working OPENAI_API_KEY is present, one
# small model call per site also confirms the site really matches the search
# and fills the business name / city / contact person from the page text.

CRAWL_CONCURRENCY = 4
# Contact enrichment visits known business sites (no listing-page harvesting),
# so it can run a few more at once.
ENRICH_CONCURRENCY = 6
CRAWL_PAGE_TIMEOUT_MS = 15_000
# Hard ceiling per site (homepage + contact pages + AI review). Crawl4AI can
# hang on some pages despite page_timeout; this keeps one site from stalling
# the run.
CRAWL_SITE_TIMEOUT_S = 60
CRAWL_MAX_EXTRA_PAGES = 3
AI_MAX_PAGE_CHARS = 12_000
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"

# schema.org types that describe the business itself (vs. a Person, WebPage…).
BUSINESS_JSONLD_TYPES = (
    "organization",
    "localbusiness",
    "corporation",
    "store",
    "restaurant",
    "hotel",
    "dentist",
    "physician",
    "medicalbusiness",
    "professionalservice",
    "homeandconstructionbusiness",
    "automotivebusiness",
    "foodestablishment",
    "cafeorcoffeeshop",
    "bakery",
    "barorpub",
    "lodgingbusiness",
    "healthandbeautybusiness",
    "legalservice",
    "financialservice",
)


def _jsonld_nodes(soup: BeautifulSoup) -> list[dict[str, Any]]:
    """Every dict node inside the page's schema.org JSON-LD blocks."""
    nodes: list[dict[str, Any]] = []

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            nodes.append(node)
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
            _walk(json.loads(raw))
        except (json.JSONDecodeError, ValueError):
            continue
    return nodes


# Generic types publishers use for themselves too (Time Out, Infatuation…).
GENERIC_ORG_JSONLD_TYPES = ("organization", "corporation")


def _is_business_node(node: dict[str, Any], *, local_only: bool = False) -> bool:
    """schema.org node describing a business. ``local_only`` excludes the
    generic Organization/Corporation types, which media sites also carry."""
    types = node.get("@type", "")
    types = types if isinstance(types, list) else [types]
    for value in types:
        lowered = str(value).lower()
        if local_only and lowered in GENERIC_ORG_JSONLD_TYPES:
            continue
        if lowered in BUSINESS_JSONLD_TYPES or lowered.endswith(("store", "business", "shop")):
            return True
    return False


def _business_name_from_page(html: str, title: str, url: str) -> str:
    """Best guess at the business name: schema.org > og:site_name > <title>."""
    soup = BeautifulSoup(html, "html.parser")
    for node in _jsonld_nodes(soup):
        name = node.get("name")
        if _is_business_node(node) and isinstance(name, str) and 2 <= len(name.strip()) <= 120:
            return _tidy_business_name(name, url)
    site_name = soup.find("meta", attrs={"property": "og:site_name"})
    if site_name and str(site_name.get("content", "")).strip():
        return _tidy_business_name(str(site_name["content"]), url)
    return _tidy_business_name(title, url)


def _tidy_business_name(raw: str, url: str) -> str:
    """"Moonlight Dentistry | Toronto Dentist" → "Moonlight Dentistry": keep the
    title segment that shares the most with the domain name."""
    host_label = _hostname(url).split(".")[0]
    raw = html_lib.unescape(raw or "")
    segments = [
        part.strip()
        for part in re.split(r"\s+[|\-–—:·•»]\s+", " ".join(raw.split()))
        if part.strip() and part.strip().lower() not in {"home", "homepage", "welcome"}
    ]
    if segments:
        def overlap(segment: str) -> int:
            compact = re.sub(r"[^a-z0-9]", "", segment.lower())
            return sum(1 for token in re.findall(r"[a-z0-9]{3,}", segment.lower()) if token in host_label) + (
                3 if compact and compact in host_label else 0
            )

        best = max(segments, key=lambda segment: (overlap(segment), -segments.index(segment)))
        return re.sub(r"^welcome to\s+", "", best, flags=re.IGNORECASE)[:80]
    return host_label.replace("-", " ").title()


# Country-level words: sites rarely print their country, so these don't
# count for the "is it in the searched place" check.
COUNTRY_WORDS = frozenset(
    {
        "united", "state", "states", "america", "usa", "kingdom", "britain", "england", "scotland",
        "wales", "canada", "australia", "zealand", "india", "pakistan", "germany", "france",
        "spain", "italy", "ireland", "emirates", "arabia", "country", "nationwide",
    }
)

ARTICLE_JSONLD_TYPES = ("article", "newsarticle", "blogposting", "itemlist")


def _page_is_article(html: str) -> bool:
    """True for news/blog/listicle pages (Article / ItemList JSON-LD). og:type
    is ignored: WordPress SEO plugins mark every ordinary page "article"."""
    soup = BeautifulSoup(html, "html.parser")
    for node in _jsonld_nodes(soup):
        types = node.get("@type", "")
        for value in types if isinstance(types, list) else [types]:
            if str(value).lower() in ARTICLE_JSONLD_TYPES:
                return True
    return False


def _page_has_business_markup(html: str) -> bool:
    """Local-business schema.org markup (Dentist, CafeOrCoffeeShop, Store…)."""
    return any(
        _is_business_node(node, local_only=True) for node in _jsonld_nodes(BeautifulSoup(html, "html.parser"))
    )


def _city_from_page(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for node in _jsonld_nodes(soup):
        locality = node.get("addressLocality")
        if isinstance(locality, str) and locality.strip():
            return locality.strip()
    return ""


class LeadAI:
    """Optional OpenAI pass over a crawled site's text (one call per site)."""

    def __init__(self, client: Any, model: str) -> None:
        self.client = client
        self.model = model
        self.failures = 0

    @classmethod
    def from_env(cls, activity: "ActivityLogger") -> "LeadAI | None":
        load_dotenv(BASE_DIR / ".env")
        api_key = os.getenv("OPENAI_API_KEY", "").strip()
        if not api_key or api_key == "your_real_key_here":
            print("No OPENAI_API_KEY — crawling without AI checks.", flush=True)
            return None
        import openai

        client = openai.OpenAI(api_key=api_key, timeout=40, max_retries=1)
        try:
            client.models.list()
        except openai.AuthenticationError:
            print("⚠ OpenAI rejected OPENAI_API_KEY — crawling without AI checks.", flush=True)
            activity.log(
                "scraping",
                "OpenAI key was rejected — crawling without AI checks",
                detail="Leads still come from each site's contact pages. Replace OPENAI_API_KEY in .env to re-enable.",
            )
            return None
        except openai.OpenAIError as exc:
            print(f"⚠ OpenAI unavailable ({exc}) — crawling without AI checks.", flush=True)
            return None
        return cls(client, os.getenv("OPENAI_MODEL", "").strip() or DEFAULT_OPENAI_MODEL)

    def review(self, query: str, url: str, page_text: str) -> dict[str, Any] | None:
        """Ask the model whether the site matches the search, plus its details.

        Returns None on any API/parse failure, so the heuristic row is kept.
        """
        prompt = (
            f"Lead search: {query or '(any business)'}\n"
            f"Website: {url}\n\n"
            "Decide whether this website is the site of ONE business that matches the "
            "lead search (right type of business; location if the search names one). "
            "News, finance, government, job boards, marketplaces, directories, "
            "list/ranking articles, and businesses of a different type do NOT match.\n"
            "Then extract the business's details using ONLY the page text below; use "
            "null for anything not written there. Never guess.\n\n"
            'Reply with JSON: {"is_match": bool, "reason": str, "business_name": str|null, '
            '"contact_name": str|null, "email": str|null, "phone": str|null, '
            '"city": str|null, "address": str|null}\n\n'
            f"PAGE TEXT:\n{page_text[:AI_MAX_PAGE_CHARS]}"
        )
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                temperature=0,
                response_format={"type": "json_object"},
                messages=[{"role": "user", "content": prompt}],
            )
            data = json.loads(response.choices[0].message.content or "{}")
            return data if isinstance(data, dict) else None
        except Exception as exc:  # noqa: BLE001 - AI is an optional refinement
            self.failures += 1
            print(f"    ⚠ AI review failed for {url}: {exc}", flush=True)
            return None


def _apply_ai_review(row: dict[str, str], review: dict[str, Any], page_text: str) -> str:
    """Merge the model's answer into ``row``. Returns a skip reason, or ""."""
    if review.get("is_match") is False:
        return f"not a match ({review.get('reason') or 'AI check'})"
    lowered_text = page_text.lower()
    page_digits = re.sub(r"\D", "", page_text)

    def text(key: str) -> str:
        value = review.get(key)
        return " ".join(str(value).split()) if isinstance(value, str) else ""

    if text("business_name"):
        row["business_name"] = text("business_name")[:80]
    # Anything contact-like must literally appear on the page, so a model
    # hallucination can never become a lead's email or phone.
    email = text("email")
    if email and not row["email"] and email.lower() in lowered_text and _is_real_email(email):
        row["email"] = email
    phone = text("phone")
    if phone and not row["phone"] and len(re.sub(r"\D", "", phone)) >= 7 and re.sub(r"\D", "", phone) in page_digits:
        row["phone"] = phone
    contact = text("contact_name")
    if contact and not row["contact_name"] and contact.lower() in lowered_text:
        row["contact_name"] = _clean_person_name(contact)
    if text("city") and not row["city"]:
        row["city"] = text("city")
    if text("address") and not row["address"]:
        row["address"] = _clean_address(text("address"))
    return ""


LISTING_MIN_PHONES = 5
LISTING_NAME_RE = re.compile(r"\b(?:directory|listings?|yellow ?pages|business finder|near me)\b", re.IGNORECASE)
# Navigation failures under load are usually transient; blocks and 4xx are not.
RETRYABLE_CRAWL_ERRORS = ("Failed on navigating", "net::ERR_CONNECTION", "Target page", "has been closed")
HARVEST_MAX_LINKS = 20
HARVEST_SKIP_HOSTS = (
    # Booking, delivery, maps and app-store links that listings carry next to
    # each business — never the business's own site.
    "apple.com", "booking.com", "deliveroo.co.uk", "doordash.com", "grubhub.com",
    "opentable.com", "opentable.co.uk", "resy.com", "sevenrooms.com", "ubereats.com",
    "just-eat.co.uk", "skipthedishes.com", "maps.app.goo.gl", "goo.gl", "bit.ly",
    "play.google.com", "apps.apple.com", "wa.me", "whatsapp.com", "t.me", "linktr.ee",
    "squarespace.com", "wix.com", "wordpress.com", "shopify.com", "godaddy.com",
)


HARVEST_SKIP_TEXT_RE = re.compile(
    r"\b(?:website|site|web design|designed|developed|powered|built|hosted|marketing)\s+by\b"
    r"|\b(?:privacy|cookies?|terms|seo agency|web agency)\b"
)


def _harvest_business_links(page: Any, base: str) -> list[str]:
    """Outbound links on a listing page that likely point at a listed
    business's own website."""
    base_host = _hostname(base)
    candidates: list[str] = []
    for link in (page.links or {}).get("external", []):
        href = link.get("href", "") if isinstance(link, dict) else str(link)
        text = str(link.get("text", "") if isinstance(link, dict) else "").lower()
        # "Website by …", "Powered by …" footer credits point at agencies.
        if HARVEST_SKIP_TEXT_RE.search(text):
            continue
        candidates.append(href)
    candidates.extend(_find_official_website_links(page.html, base, ""))

    found: list[str] = []
    hosts: set[str] = set()
    for href in candidates:
        href = (href or "").strip()
        # tel:, mailto:, javascript: … would otherwise be "normalized" into
        # https://tel:+1416… by _normalized_web_url.
        if re.match(r"^[a-z][a-z0-9+.\-]*:", href, re.IGNORECASE) and not href.lower().startswith(("http://", "https://")):
            continue
        url = _normalized_web_url(urljoin(base, href))
        host = _hostname(url)
        if not url or host == base_host or host in hosts or _is_dead_end_url(url) or _is_directory_url(url):
            continue
        # A listing may deep-link (a menu, a press release); the business's
        # homepage is the right place to start reading it.
        parsed_link = urlparse(url)
        url = f"{parsed_link.scheme}://{parsed_link.netloc}/"
        if any(host == skip or host.endswith(f".{skip}") for skip in HARVEST_SKIP_HOSTS):
            continue
        # Same registrable site as the listing (cdn.example.com, shop.example.com).
        if base_host.split(".")[-2:] == host.split(".")[-2:]:
            continue
        hosts.add(host)
        found.append(url)
        if len(found) >= HARVEST_MAX_LINKS:
            break
    return found


async def _read_site_pages(crawler: Any, run_config: Any, home: Any, base: str) -> list[Any]:
    """The already-loaded page plus the site's homepage (if ``base`` is a deep
    page) and up to CRAWL_MAX_EXTRA_PAGES contact/about pages."""
    parsed = urlparse(base)
    root = f"{parsed.scheme}://{parsed.netloc}/"
    seen = {base.rstrip("/").lower()}
    targets: list[str] = []

    def queue(link: str) -> None:
        key = link.rstrip("/").lower()
        if key not in seen and len(targets) < CRAWL_MAX_EXTRA_PAGES:
            seen.add(key)
            targets.append(link)

    # A search hit can be a deep page; the homepage carries the business name.
    if parsed.path.strip("/"):
        queue(root)
    contact_links = _find_contact_links(home.html, base)
    for link in contact_links:
        queue(link)
    if not contact_links:
        for guess in ("contact", "contact-us"):
            queue(urljoin(root, guess))

    pages = [home]
    if targets:
        extra = await crawler.arun_many(targets, config=run_config)
        pages.extend(result for result in extra if result.success and result.html)
    return pages


def _contacts_from_pages(pages: list[Any]) -> tuple[list[str], list[str], list[str], list[str]]:
    emails: list[str] = []
    phones: list[str] = []
    addresses: list[str] = []
    names: list[str] = []
    for page in pages:
        found_emails, found_phones, found_addresses, found_names = _extract_contacts_from_html(page.html)
        emails.extend(e for e in found_emails if e.lower() not in {x.lower() for x in emails})
        phones.extend(p for p in found_phones if p not in phones)
        addresses.extend(a for a in found_addresses if a.lower() not in {x.lower() for x in addresses})
        names.extend(n for n in found_names if n not in names)
    return emails, phones, addresses, names


def _crawler_configs() -> tuple[Any, Any]:
    from crawl4ai import BrowserConfig, CacheMode, CrawlerRunConfig

    browser_config = BrowserConfig(headless=True, verbose=False, enable_stealth=True)
    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        page_timeout=CRAWL_PAGE_TIMEOUT_MS,
        wait_until="domcontentloaded",
        delay_before_return_html=1.0,
        remove_overlay_elements=True,
        magic=True,
        simulate_user=True,
        override_navigator=True,
        verbose=False,
    )
    return browser_config, run_config


async def _crawl_site(
    crawler: Any, run_config: Any, url: str, query: str, ai: LeadAI | None
) -> tuple[dict[str, str] | None, str, list[str]]:
    """Crawl one candidate. Returns (row, skip_reason, harvested_links).

    A business site yields a row (homepage + up to 3 contact/about pages are
    read). A listing page — directory, ranking article, guide — yields no row
    but the outbound links to the businesses it lists.
    """
    home = await crawler.arun(url, config=run_config)
    if not home.success and any(marker in (home.error_message or "") for marker in RETRYABLE_CRAWL_ERRORS):
        home = await crawler.arun(url, config=run_config)
    if not home.success or not home.html:
        reason = home.error_message or f"HTTP {home.status_code}"
        return None, f"could not load ({reason.splitlines()[0][:120]})", []

    base = home.redirected_url or url
    title = (home.metadata or {}).get("title") or ""
    _, home_phones, _, _ = _extract_contacts_from_html(home.html)
    distinct_phones = {re.sub(r"\D", "", phone)[-10:] for phone in home_phones}
    # A page with schema.org business markup is a business (multi-location
    # ones list several numbers) — unless it's on a known directory, whose
    # profile pages carry the listed business's markup.
    if _is_directory_url(base) or (
        not _page_has_business_markup(home.html)
        and (
            _looks_like_listing_url(base, title, strict=True)
            or _page_is_article(home.html)
            or len(distinct_phones) >= LISTING_MIN_PHONES
        )
    ):
        links = _harvest_business_links(home, base)
        return None, f"listing page — queued {len(links)} linked business site(s)", links

    parsed = urlparse(base)
    root = f"{parsed.scheme}://{parsed.netloc}/"
    pages = await _read_site_pages(crawler, run_config, home, base)
    emails, phones, addresses, names = _contacts_from_pages(pages)

    name_page = next(
        (page for page in pages if not urlparse(page.redirected_url or page.url).path.strip("/")),
        home,
    )
    row = {
        "business_name": _business_name_from_page(
            name_page.html, (name_page.metadata or {}).get("title") or "", root
        ),
        "contact_name": names[0] if names else "",
        "email": _choose_email(emails, root),
        "phone": phones[0] if phones else "",
        "website": _normalized_web_url(root),
        "city": next((city for city in (_city_from_page(page.html) for page in pages) if city), ""),
        "address": addresses[0] if addresses else "",
        # Already crawled in depth here, so the enrichment pass skips it.
        "_crawled": "1",
    }

    if LISTING_NAME_RE.search(row["business_name"]):
        return None, f"directory site ({row['business_name']})", _harvest_business_links(home, base)

    page_text = "\n\n".join(
        str(getattr(page.markdown, "raw_markdown", None) or page.markdown or "") for page in pages
    )
    # The site must actually talk about the searched business type — this is
    # what stops "insurance we accept" links on a dentist's site from turning
    # into insurance-company leads. (Cheap, so it also saves AI calls.)
    stems, compact = _query_keywords(query) if query else ([], "")
    # Full visible text (footers included — where cafés print their address);
    # Crawl4AI's markdown can drop footers.
    visible_text = " ".join(" ".join(BeautifulSoup(page.html, "html.parser").get_text(" ").split()) for page in pages)
    haystack = f"{title} {visible_text} {row['address']} {row['city']}".lower()
    if stems and not _relevance(stems, compact, haystack):
        return None, f"doesn't mention “{' '.join(stems)}”", []
    # …and be in the searched place, when one was given.
    places = [
        token for token in _query_location_tokens(query) if len(token) >= 4 and token not in COUNTRY_WORDS
    ]
    if places and not any(token in haystack for token in places):
        return None, f"not in {' '.join(places).title()}", []

    if ai is not None:
        review = await asyncio.to_thread(ai.review, query, base, page_text)
        if review:
            reason = _apply_ai_review(row, review, page_text)
            if reason:
                return None, reason, []

    if not (row["email"] or row["phone"]):
        return None, "no public email or phone found", []
    # Without the AI check, demand a stronger business signal than a lone
    # email address (blogs and media sites publish one too): a phone number,
    # or schema.org business markup.
    if ai is None and not row["phone"] and not any(_page_has_business_markup(page.html) for page in pages):
        return None, "no phone or business markup (looks like a content site)", []
    return row, "", []


async def _crawl_business_sites(
    urls: list[str],
    query: str,
    *,
    target: int,
    max_sites: int,
    progress: "ProgressReporter",
    activity: "ActivityLogger",
    erp: "ErpNextSync | None",
    ai: LeadAI | None,
) -> tuple[list[dict[str, str]], int]:
    from crawl4ai import AsyncWebCrawler

    browser_config, run_config = _crawler_configs()
    pending = list(urls)
    queued_hosts = {_hostname(url) for url in urls}
    # Sites reached through a listing never harvest further, so the crawl
    # can't wander (dentist → insurer → bank → …).
    harvested_urls: set[str] = set()
    rows: list[dict[str, str]] = []
    processed = 0
    crawler = AsyncWebCrawler(config=browser_config)
    await crawler.start()

    async def crawl_with_deadline(url: str) -> tuple[dict[str, str] | None, str, list[str]]:
        try:
            return await asyncio.wait_for(
                _crawl_site(crawler, run_config, url, query, ai), timeout=CRAWL_SITE_TIMEOUT_S
            )
        except asyncio.TimeoutError:
            return None, f"timed out after {CRAWL_SITE_TIMEOUT_S}s", []

    try:
        while pending and processed < max_sites:
            batch = pending[: min(CRAWL_CONCURRENCY, max_sites - processed)]
            del pending[: len(batch)]
            progress.total = min(max_sites, processed + len(batch) + len(pending))
            progress.completed = processed
            progress.update(
                "running",
                current_url=batch[0],
                message=f"Crawling sites {processed + 1}–{processed + len(batch)} of {progress.total}",
            )
            for offset, url in enumerate(batch):
                print(f"[{processed + offset + 1}/{progress.total}] Crawling {url}", flush=True)
                activity.log("scraping", f"Crawling {url}", detail=f"{processed + offset + 1} of {progress.total}")

            results = await asyncio.gather(
                *(crawl_with_deadline(url) for url in batch),
                return_exceptions=True,
            )
            harvested: list[str] = []
            for url, result in zip(batch, results):
                processed += 1
                if isinstance(result, BaseException):
                    message = str(result).splitlines()[0][:120] if str(result) else type(result).__name__
                    row, reason, links = None, f"crawl error ({message})", []
                else:
                    row, reason, links = result
                # Harvesting only applies to discovery; a urls.txt run crawls
                # exactly the listed sites.
                for link in links if target and url not in harvested_urls else []:
                    host = _hostname(link)
                    if host in queued_hosts or (erp is not None and erp.skip_existing and erp.has_website(link)):
                        continue
                    queued_hosts.add(host)
                    harvested.append(link)
                    harvested_urls.add(link)
                if row is None:
                    print(f"    ↳ Skipping {url}: {reason}", flush=True)
                    activity.log("scraping", f"Skipped {url}", detail=reason)
                    continue
                if not _skip_existing(erp, [row], activity):
                    continue
                rows.append(row)
                found = [label for label in ("email", "phone", "address", "contact_name") if row.get(label)]
                print(f"    ↳ Lead: {row['business_name']} ({', '.join(found)})", flush=True)
                activity.log("lead_found", f"Found lead: {row['business_name']}", detail=f"Has {', '.join(found)}")
            # Businesses found on a listing are the best remaining candidates:
            # crawl them before the rest of the search results.
            pending[:0] = harvested

            if target and len(deduplicate_leads(rows)) >= target:
                activity.log(
                    "scraping",
                    f"Reached the target of {target} lead(s)",
                    detail=f"Crawled {processed} site(s)",
                )
                break
    finally:
        try:
            await asyncio.wait_for(crawler.close(), timeout=30)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001 - never hang on shutdown
            pass
    progress.completed = processed
    return rows, processed


async def _enrich_rows_with_crawler(
    rows: list[dict[str, str]], progress: "ProgressReporter", activity: "ActivityLogger"
) -> None:
    from crawl4ai import AsyncWebCrawler

    browser_config, run_config = _crawler_configs()
    todo = [
        row
        for row in rows
        if not row.get("_crawled")
        and row.get("website", "").strip()
        and not (row.get("email") and row.get("phone") and row.get("address"))
    ]
    if not todo:
        return

    async def enrich(row: dict[str, str]) -> None:
        website = _normalized_web_url(row["website"])
        home = await crawler.arun(website, config=run_config)
        if not home.success and any(marker in (home.error_message or "") for marker in RETRYABLE_CRAWL_ERRORS):
            home = await crawler.arun(website, config=run_config)
        if not home.success or not home.html:
            return
        pages = await _read_site_pages(crawler, run_config, home, home.redirected_url or website)
        emails, phones, addresses, names = _contacts_from_pages(pages)
        for field, value in (
            ("email", _choose_email(emails, website)),
            ("phone", phones[0] if phones else ""),
            ("address", addresses[0] if addresses else ""),
            ("contact_name", names[0] if names else ""),
            ("city", next((c for c in (_city_from_page(page.html) for page in pages) if c), "")),
        ):
            if value and not row.get(field, "").strip():
                row[field] = value

    # A rolling pool rather than fixed batches: a slow site (big chain
    # locator pages often hit the timeout) only holds up its own slot.
    slots = asyncio.Semaphore(ENRICH_CONCURRENCY)
    done = 0

    async def enrich_in_slot(row: dict[str, str]) -> None:
        nonlocal done
        async with slots:
            print(f"    ↳ Crawling {row['website']} for {row.get('business_name') or 'lead'}", flush=True)
            progress.update(
                "enriching",
                current_url=row["website"],
                message=f"Reading websites for contact details ({done} of {len(todo)} done)",
            )
            try:
                await asyncio.wait_for(enrich(row), timeout=CRAWL_SITE_TIMEOUT_S)
            except Exception:  # noqa: BLE001 - one bad site must not stop the rest
                pass
        done += 1
        found = [label for label in ("contact_name", "email", "phone", "address") if row.get(label, "").strip()]
        activity.log(
            "enriching",
            f"Checked contact pages for {row.get('business_name') or row['website']}",
            detail=f"Found {', '.join(found)}" if found else "No public contact details found",
        )

    crawler = AsyncWebCrawler(config=browser_config)
    await crawler.start()
    try:
        await asyncio.gather(*(enrich_in_slot(row) for row in todo))
    finally:
        try:
            await asyncio.wait_for(crawler.close(), timeout=30)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001 - never hang on shutdown
            pass


def enrich_rows_with_crawler(
    rows: list[dict[str, str]], *, progress: "ProgressReporter", activity: "ActivityLogger"
) -> list[dict[str, str]]:
    """Fill missing contacts by crawling each lead's own website with
    Crawl4AI. Falls back to the plain-HTTP/Playwright enricher if the
    crawler can't start."""
    try:
        asyncio.run(_enrich_rows_with_crawler(rows, progress, activity))
    except Exception as exc:  # noqa: BLE001 - enrichment must never lose the leads
        print(f"    ⚠ Crawl4AI enrichment failed ({exc}); using the basic enricher.", flush=True)
        return enrich_rows_with_contacts(rows, progress=progress, activity=activity)
    for row in rows:
        row.pop("_source_url", None)
        row.pop("_crawled", None)
    return rows


def crawl_business_sites(
    urls: list[str],
    query: str,
    *,
    target: int,
    progress: "ProgressReporter",
    activity: "ActivityLogger",
    erp: "ErpNextSync | None",
    ai: LeadAI | None,
) -> tuple[list[dict[str, str]], int]:
    """Crawl candidate sites until ``target`` new leads are found (0 = crawl
    exactly the given URLs). Listing pages found in query mode add their linked
    businesses to the queue, bounded by a total crawl budget.

    Returns (lead rows, number of sites crawled).
    """
    max_sites = min(120, max(20, target * 6)) if target else len(urls)
    return asyncio.run(
        _crawl_business_sites(
            urls,
            query,
            target=target,
            max_sites=max_sites,
            progress=progress,
            activity=activity,
            erp=erp,
            ai=ai,
        )
    )


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


# --- ERPNext integration ---------------------------------------------------
# Duplicate-matching rules mirror lib/erpnext.ts — keep the two in step so the
# scraper and the dashboard's "Sync to ERPNext" button agree on what counts as
# "already in ERPNext".

# Hosts shared by many unrelated businesses: only host + path identifies one
# (facebook.com/joespizza, yelp.com/biz/joes-pizza).
ERP_SHARED_HOSTS = frozenset(
    {
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
    }
)


def _erp_email_key(value: str) -> str:
    email = (value or "").strip().lower()
    return email if "@" in email else ""


def _erp_phone_key(value: str) -> str:
    """Last 10 digits, so "+44 20 7946 0958" and "020 7946 0958" collide."""
    digits = re.sub(r"\D", "", value or "")
    return digits[-10:] if len(digits) >= 7 else ""


def _erp_website_key(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    if not re.match(r"^https?://", raw, re.IGNORECASE):
        raw = f"https://{raw}"
    try:
        parsed = urlparse(raw)
    except ValueError:
        return ""
    host = (parsed.hostname or "").lower().removeprefix("www.")
    if "." not in host:
        return ""
    if host in ERP_SHARED_HOSTS:
        page = parsed.path.strip("/").lower()
        return f"{host}/{page}" if page else ""
    return host


def _erp_name_key(value: str) -> str:
    key = re.sub(r"[^a-z0-9]+", "", (value or "").lower())
    return key if len(key) >= 4 else ""


def _frappe_error(response: requests.Response) -> str:
    """Human-readable reason from a Frappe error body."""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        server_messages = body.get("_server_messages")
        if isinstance(server_messages, str):
            try:
                parts = []
                for item in json.loads(server_messages):
                    try:
                        parts.append(str(json.loads(item).get("message", item)))
                    except (ValueError, AttributeError):
                        parts.append(str(item))
                text = re.sub(r"<[^>]+>", "", " ".join(parts)).strip()
                if text:
                    return text
            except ValueError:
                pass
        if isinstance(body.get("exception"), str):
            return body["exception"].splitlines()[0]
        if isinstance(body.get("message"), str):
            return body["message"]
    if response.status_code in (401, 403):
        return "ERP rejected the API key/secret, or this user lacks permission."
    return f"ERP responded with HTTP {response.status_code}."


def _lead_note_html(row: dict[str, str]) -> str:
    """Address / store type / Google rating as an HTML note for the ERPNext Lead."""
    import html as _html

    lines = [
        ("Store type", row.get("store_type", "")),
        ("Address", row.get("address", "")),
        ("Google rating", row.get("_rating", "")),
        ("Found by", "TrityReach lead finder"),
    ]
    filled = [(label, _html.escape(value)) for label, value in lines if value]
    if row.get("lat") and row.get("lng"):
        # The dashboard's map reads the position back from this link.
        coords = f"{row['lat']},{row['lng']}"
        filled.insert(
            -1,
            ("Map", f'<a href="https://www.google.com/maps/search/?api=1&amp;query={coords}">{coords}</a>'),
        )
    if len(filled) <= 1:
        return ""
    return "<br>".join(f"<b>{label}:</b> {value}" for label, value in filled)


class ErpNextSync:
    """Skips leads that already exist in the user's ERPNext and saves new ones.

    Configured from ERPNEXT_* env vars, which the dashboard sets from its
    Integrations page when it spawns this script (they can also live in .env
    for CLI runs). Disabled entirely when ERPNEXT_URL is empty.
    """

    def __init__(
        self,
        url: str,
        api_key: str,
        api_secret: str,
        *,
        save_leads: bool,
        skip_existing: bool,
    ) -> None:
        self.url = url.rstrip("/")
        self.save_leads = save_leads
        self.skip_existing = skip_existing
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": f"token {api_key}:{api_secret}",
            }
        )
        self.emails: set[str] = set()
        self.phones: set[str] = set()
        self.websites: set[str] = set()
        # name key -> cities it was seen in ("" = unknown city)
        self.names: dict[str, set[str]] = {}
        self.records = 0
        # Leads/websites dropped this run because they were already in ERPNext.
        self.skipped = 0
        # ERPNext couldn't be reached at the start of the run: the run goes on
        # without it and new leads wait in PENDING_ERP_PATH.
        self.offline = False
        # Rows whose save failed this run (they wait in PENDING_ERP_PATH too).
        self.failed_rows: list[dict[str, str]] = []

    @classmethod
    def from_env(cls) -> "ErpNextSync | None":
        load_dotenv(BASE_DIR / ".env")
        url = os.getenv("ERPNEXT_URL", "").strip()
        api_key = os.getenv("ERPNEXT_API_KEY", "").strip()
        api_secret = os.getenv("ERPNEXT_API_SECRET", "").strip()
        if not (url and api_key and api_secret):
            return None
        return cls(
            url,
            api_key,
            api_secret,
            save_leads=os.getenv("ERPNEXT_SAVE_LEADS", "1").strip() != "0",
            skip_existing=os.getenv("ERPNEXT_SKIP_EXISTING", "1").strip() != "0",
        )

    def _get(self, path: str, params: dict[str, str]) -> Any:
        try:
            response = self.session.get(f"{self.url}{path}", params=params, timeout=60)
        except requests.RequestException as exc:
            raise ValueError(f"Could not reach ERP at {self.url} ({exc})") from exc
        if not response.ok:
            raise ValueError(_frappe_error(response))
        return response.json()

    def _add(
        self,
        *,
        names: list[str],
        emails: list[str],
        phones: list[str],
        website: str,
        city: str,
    ) -> None:
        for email in emails:
            if _erp_email_key(email):
                self.emails.add(_erp_email_key(email))
        for phone in phones:
            if _erp_phone_key(phone):
                self.phones.add(_erp_phone_key(phone))
        if _erp_website_key(website):
            self.websites.add(_erp_website_key(website))
        for name in names:
            key = _erp_name_key(name)
            if key:
                self.names.setdefault(key, set()).add((city or "").strip().lower())
        self.records += 1

    def load_existing(self) -> int:
        """Index every Lead (and Customer, when readable). Returns records indexed."""
        lead_fields = ["lead_name", "company_name", "email_id", "mobile_no", "phone", "website", "city"]
        data = self._get(
            "/api/resource/Lead",
            {"fields": json.dumps(lead_fields), "limit_page_length": "0"},
        )
        for row in data.get("data", []):
            self._add(
                names=[row.get("company_name") or "", row.get("lead_name") or ""],
                emails=[row.get("email_id") or ""],
                phones=[row.get("mobile_no") or "", row.get("phone") or ""],
                website=row.get("website") or "",
                city=row.get("city") or "",
            )
        # Existing customers are just as much "already known". Not every API
        # user may read Customer, so this part is best-effort.
        try:
            customer_fields = ["customer_name", "email_id", "mobile_no", "website"]
            data = self._get(
                "/api/resource/Customer",
                {"fields": json.dumps(customer_fields), "limit_page_length": "0"},
            )
            for row in data.get("data", []):
                self._add(
                    names=[row.get("customer_name") or ""],
                    emails=[row.get("email_id") or ""],
                    phones=[row.get("mobile_no") or ""],
                    website=row.get("website") or "",
                    city="",
                )
        except ValueError as exc:
            print(f"    ⚠ Could not read ERP Customers (leads only): {exc}", flush=True)
        return self.records

    def has_website(self, url: str) -> bool:
        key = _erp_website_key(url)
        return bool(key) and key in self.websites

    def match(self, row: dict[str, str]) -> str:
        """Why ``row`` is already in ERPNext, or "" when it is new."""
        email = _erp_email_key(row.get("email", ""))
        if email and email in self.emails:
            return f"email {row.get('email')}"
        phone = _erp_phone_key(row.get("phone", ""))
        if phone and phone in self.phones:
            return f"phone {row.get('phone')}"
        site = _erp_website_key(row.get("website", ""))
        if site and site in self.websites:
            return f"website {site}"
        name = _erp_name_key(row.get("business_name", ""))
        cities = self.names.get(name) if name else None
        if cities is not None:
            city = (row.get("city") or "").strip().lower()
            if not city or "" in cities or city in cities:
                return f"name {row.get('business_name')}"
        return ""

    def split_existing(
        self, rows: list[dict[str, str]]
    ) -> tuple[list[dict[str, str]], list[tuple[dict[str, str], str]]]:
        """Partition rows into (new, [(existing_row, reason), ...])."""
        if not self.skip_existing:
            return rows, []
        new_rows: list[dict[str, str]] = []
        existing: list[tuple[dict[str, str], str]] = []
        for row in rows:
            reason = self.match(row)
            if reason:
                existing.append((row, reason))
            else:
                new_rows.append(row)
        return new_rows, existing

    @staticmethod
    def lead_doc(row: dict[str, str]) -> dict[str, str]:
        """Map a lead row onto ERPNext's Lead doctype (unknown fields are ignored
        by Frappe, so this works across v13–v15)."""
        business = (row.get("business_name") or "").strip()
        person = (row.get("contact_name") or "").strip()
        # first_name only when there's a real person: ERPNext v14+ rebuilds
        # lead_name from it, and with none it falls back to company_name.
        first, *rest = person.split() or [""]
        doc = {
            "lead_name": person or business,
            "first_name": first,
            "last_name": " ".join(rest),
            "company_name": business,
            "email_id": (row.get("email") or "").strip(),
            "mobile_no": (row.get("phone") or "").strip(),
            "phone": (row.get("phone") or "").strip(),
            "website": (row.get("website") or "").strip(),
            "city": (row.get("city") or "").strip(),
            # Filled on sites with a custom "Address" field on Lead; Frappe
            # ignores fields a site doesn't have.
            "custom_address": (row.get("address") or "").strip(),
        }
        doc = {key: value for key, value in doc.items() if value}
        note = _lead_note_html(row)
        if note:
            # ERPNext v14+ keeps notes in the "CRM Note" child table; the Lead
            # doctype has no street-address field, so the note carries it.
            doc["notes"] = [{"note": note}]
        return doc

    def create_lead(self, row: dict[str, str]) -> str:
        doc = self.lead_doc(row)
        try:
            response = self.session.post(f"{self.url}/api/resource/Lead", json=doc, timeout=30)
            if not response.ok and "notes" in doc:
                # Older ERPNext (v13) has a plain-text notes field: retry without.
                doc.pop("notes")
                response = self.session.post(f"{self.url}/api/resource/Lead", json=doc, timeout=30)
        except requests.RequestException as exc:
            raise ValueError(f"Could not reach ERP ({exc})") from exc
        if not response.ok:
            raise ValueError(_frappe_error(response))
        name = str((response.json().get("data") or {}).get("name", ""))
        self._add(
            names=[row.get("business_name", "")],
            emails=[row.get("email", "")],
            phones=[row.get("phone", "")],
            website=row.get("website", ""),
            city=row.get("city", ""),
        )
        return name

    def save(self, rows: list[dict[str, str]], activity: "ActivityLogger") -> int:
        """Create each row as an ERPNext Lead. Failures are logged, never fatal."""
        created = 0
        failed: list[str] = []
        for row in rows:
            label = row.get("business_name") or row.get("website") or "lead"
            if not (row.get("business_name") or "").strip():
                failed.append(f"{label}: no business name")
                continue
            try:
                name = self.create_lead(row)
                created += 1
                print(f"    ↳ Saved {label} to ERP as {name}", flush=True)
            except ValueError as exc:
                failed.append(f"{label}: {exc}")
                self.failed_rows.append(row)
                print(f"    ⚠ ERP save failed for {label}: {exc}", flush=True)
        activity.log(
            "erpnext",
            f"Saved {created} of {len(rows)} lead(s) to ERP",
            detail=("; ".join(failed) if failed else self.url),
        )
        return created


# Leads found while ERPNext was offline (or whose save failed). The dashboard
# keeps showing them (lib/storage.ts readLeads), the next run with ERPNext
# reachable saves them, and "Sync to ERP" clears them too.
PENDING_ERP_PATH = BASE_DIR / "data" / "erp-pending.json"


def _pending_key(row: dict[str, str]) -> str:
    return (row.get("email") or row.get("phone") or row.get("website") or row.get("business_name") or "").strip().lower()


def read_pending_erp() -> list[dict[str, str]]:
    try:
        rows = json.loads(PENDING_ERP_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def write_pending_erp(rows: list[dict[str, str]]) -> None:
    PENDING_ERP_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = PENDING_ERP_PATH.with_suffix(".json.tmp")
    try:
        temporary_path.write_text(json.dumps(rows, indent=2), encoding="utf-8")
        temporary_path.replace(PENDING_ERP_PATH)
    finally:
        temporary_path.unlink(missing_ok=True)


def add_pending_erp(rows: list[dict[str, str]]) -> None:
    pending = read_pending_erp()
    keys = {_pending_key(row) for row in pending}
    for row in rows:
        if _pending_key(row) and _pending_key(row) not in keys:
            keys.add(_pending_key(row))
            pending.append({field: str(row.get(field, "") or "") for field in CSV_FIELDS})
    write_pending_erp(pending)


def flush_pending_erp(erp: ErpNextSync, activity: "ActivityLogger") -> None:
    """ERPNext is reachable again: save the leads that waited for it (ones it
    meanwhile got some other way are just dropped from the list)."""
    pending = read_pending_erp()
    if not pending:
        return
    print(f"Saving {len(pending)} lead(s) that waited while ERP was offline...", flush=True)
    still_waiting: list[dict[str, str]] = []
    created = already = 0
    for row in pending:
        if erp.match(row):
            already += 1
            continue
        try:
            erp.create_lead(row)
            created += 1
        except ValueError:
            still_waiting.append(row)
    write_pending_erp(still_waiting)
    activity.log(
        "erpnext",
        f"Saved {created} lead(s) that waited while ERP was offline",
        detail=", ".join(
            filter(None, [f"{already} were already there" if already else "", f"{len(still_waiting)} still waiting" if still_waiting else ""])
        ) or "Nothing left waiting",
    )


def _skip_existing(
    erp: ErpNextSync | None,
    rows: list[dict[str, str]],
    activity: "ActivityLogger",
) -> list[dict[str, str]]:
    """Drop rows already in ERPNext, logging which and why."""
    if erp is None or erp.offline or not rows:
        return rows
    new_rows, existing = erp.split_existing(rows)
    erp.skipped += len(existing)
    for row, reason in existing:
        label = row.get("business_name") or row.get("website") or "lead"
        print(f"    ↳ Skipping {label}: already in ERP ({reason})", flush=True)
        activity.log("erpnext", f"Skipped {label} — already in ERP", detail=f"Matched on {reason}")
    return new_rows


def _drop_same_contact(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    """Keep one row per contact key — email, else phone — the identity the
    dashboard merges leads on (leadKeyForClient in lib/lead-key.ts)."""
    seen: set[str] = set()
    kept: list[dict[str, str]] = []
    for row in rows:
        key = (row.get("email") or row.get("phone") or "").strip().lower()
        if key and key in seen:
            continue
        seen.add(key)
        kept.append(row)
    return kept


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    try:
        with temporary_path.open("w", newline="", encoding="utf-8-sig") as handle:
            # Private "_…" helper keys (rating, crawl markers) stay out of the CSV.
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
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
        "erpnext",
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
        # Why a finished run came up short of its target (shown on the dashboard).
        self.notice = ""

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
            "notice": self.notice,
            "pid": os.getpid(),
            "updatedAt": datetime.now(UTC).isoformat(),
        }
        temporary_path = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            temporary_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            temporary_path.replace(self.path)
        finally:
            temporary_path.unlink(missing_ok=True)


def _finish_run(
    args: argparse.Namespace,
    rows: list[dict[str, str]],
    progress: "ProgressReporter",
    activity: "ActivityLogger",
    processed_sources: int,
    erp: ErpNextSync | None = None,
    *,
    target: int = 0,
    shortfall: str = "",
) -> None:
    """Shared tail for both discovery sources:
    enrich → skip ERPNext duplicates → save CSV → save to ERPNext → webhook → done.

    With a ``target`` (store finder), a run that ends short of it says why:
    ``shortfall`` from discovery, plus stores dropped after enrichment."""

    def shortfall_notice(found: int, late_matches: int = 0, same_contact: int = 0) -> str:
        if not target or found >= target:
            return ""
        reasons = [shortfall] if shortfall else []
        if late_matches:
            reasons.append(
                f"{late_matches} more turned out to be in ERP once "
                + ("its website was read" if late_matches == 1 else "their websites were read")
            )
        if same_contact:
            reasons.append(f"{same_contact} shared an email with another store")
        if not shortfall and reasons:
            reasons[-1] += ". Run it again to top up."
        return f"Found {found} of {target} stores — " + "; ".join(reasons) if reasons else ""

    if not rows and erp is not None and erp.skipped:
        progress.notice = shortfall_notice(0)
        _finish_without_new_leads(args, progress, activity, processed_sources, erp)
        return
    if not rows:
        activity.log("failed", "No matching leads were extracted")
        raise ValueError(
            shortfall_notice(0) or "No matching leads were extracted. Try a more specific business type and location."
        )

    # Visit each lead's own website and dig its contact/about pages so that
    # missing emails and phone numbers are filled in from the source site.
    # (Maps leads with no website are simply left as-is here.)
    pending = sum(1 for row in rows if not row.get("_crawled"))
    if pending:
        print(f"Enriching {pending} lead(s) with contact details...", flush=True)
        activity.log("enriching", f"Enriching {pending} lead(s) with contact details")
    rows = enrich_rows_with_crawler(rows, progress=progress, activity=activity)

    # Enrichment can surface an email/phone that ERPNext already has, so check
    # again now that every row is complete.
    before_recheck = len(rows)
    rows = _skip_existing(erp, rows, activity)
    late_matches = before_recheck - len(rows)
    before_merge = len(rows)
    rows = _drop_same_contact(rows)
    progress.notice = shortfall_notice(len(rows), late_matches, before_merge - len(rows))
    if not rows and erp is not None:
        _finish_without_new_leads(args, progress, activity, processed_sources, erp)
        return

    write_csv(args.output, rows)

    # Save the new leads into the connected ERPNext before outreach starts, so
    # the ERP is the record of who was contacted.
    erp_note = ""
    if erp is not None and erp.offline:
        add_pending_erp(rows)
        erp_note = f"; ERP offline — {len(rows)} kept to save there later"
        progress.notice = " ".join(
            filter(
                None,
                [
                    progress.notice,
                    "ERP was offline, so these leads weren't checked against it or saved there. They stay in the CRM "
                    "and are saved to ERP automatically on the next run once it's back (or use Sync to ERP on the CRM page).",
                ],
            )
        )
    elif erp is not None and erp.save_leads:
        print(f"Saving {len(rows)} lead(s) to ERP...", flush=True)
        progress.update("enriching", message=f"Saving {len(rows)} lead(s) to ERP")
        saved = erp.save(rows, activity)
        erp_note = f"; {saved} saved to ERP"
        if erp.failed_rows:
            add_pending_erp(erp.failed_rows)
            erp_note += f" ({len(erp.failed_rows)} kept to retry later)"
    if erp is not None and erp.skipped:
        erp_note += f"; {erp.skipped} already in ERP skipped"

    # Hand the saved leads to the n8n outreach webhook, when configured.
    webhook_url = (args.webhook_url or os.getenv("N8N_WEBHOOK_URL", "")).strip()
    delivery_note = ""
    if webhook_url and getattr(args, "no_outreach", False):
        delivery_note = "; outreach not started (start calls from the CRM page)"
        activity.log(
            "webhook_sent",
            "Automatic outreach is off for this run",
            detail="Review the leads, then use Call / Email on the CRM page",
        )
    elif webhook_url:
        print(f"Delivering {len(rows)} lead(s) to the outreach webhook...", flush=True)
        activity.log("webhook_sent", f"Sending {len(rows)} lead(s) to the n8n outreach webhook")
        delivered = post_rows_to_webhook(webhook_url, rows)
        delivery_note = f"; {delivered} sent to outreach"
        activity.log("webhook_sent", f"Delivered {delivered} of {len(rows)} lead(s) to n8n")

    progress.total = processed_sources or len(rows)
    progress.completed = progress.total
    progress.update("completed", message=f"Saved {len(rows)} lead(s){erp_note}{delivery_note}")
    activity.log("completed", f"Saved {len(rows)} lead(s) to leads.csv{erp_note}{delivery_note}", detail=progress.notice)
    print(f"Saved {len(rows)} lead(s) to {args.output.expanduser().resolve()}{erp_note}{delivery_note}")
    if progress.notice:
        print(progress.notice)


def _finish_without_new_leads(
    args: argparse.Namespace,
    progress: "ProgressReporter",
    activity: "ActivityLogger",
    processed_sources: int,
    erp: ErpNextSync,
) -> None:
    """Every lead found was already in ERPNext: a successful run, just nothing new."""
    write_csv(args.output, [])
    message = f"No new leads — all {erp.skipped} match(es) are already in ERP"
    progress.total = processed_sources or erp.skipped
    progress.completed = progress.total
    progress.update("completed", message=message)
    activity.log("completed", message, detail=progress.notice or "Try a different keyword or location for fresh prospects")
    print(message)


def main() -> int:
    args = parse_args()
    progress = ProgressReporter(args.progress_file, args.job_id)
    activity = ActivityLogger(args.activity_file)
    try:
        query = " ".join((args.query or "").split())
        progress.query = query

        # When an ERPNext site is connected, index what it already holds so
        # duplicates are dropped before they cost scraping, enrichment, or an
        # outreach message.
        # If ERPNext can't be reached the run still goes ahead without it:
        # no ERP duplicate check, and new leads wait locally to be saved later.
        erp = ErpNextSync.from_env()
        if erp is not None and erp.skip_existing:
            progress.update("discovering", message="Checking existing leads in ERP")
            print(f"Loading existing leads from ERP at {erp.url}...", flush=True)
            try:
                count = erp.load_existing()
            except ValueError as exc:
                erp.offline = True
                print(f"    ⚠ ERP is offline, continuing without it: {exc}", flush=True)
                activity.log(
                    "erpnext",
                    "ERP is offline — searching without it",
                    detail="No ERP duplicate check this run; new leads are kept and saved to ERP once it's back",
                )
            else:
                activity.log(
                    "erpnext",
                    f"Loaded {count} existing record(s) from ERP",
                    detail="Leads already there will be skipped",
                )
        if erp is not None and not erp.offline and erp.save_leads:
            flush_pending_erp(erp, activity)

        # Store Finder: Google Maps across store types × locations, chains and
        # ERPNext duplicates already filtered out, then the shared tail.
        if args.source == "stores":
            store_keys = parse_store_types(args.store_types)
            locations = parse_locations(args.locations)
            if not 1 <= args.max_results <= 1000:
                raise ValueError("max-results must be between 1 and 1000 for the store finder.")
            maps_key = require_maps_api_key()
            label = store_search_label(store_keys, locations)
            progress.query = label
            progress.update("discovering", message=f"Searching Google Maps for {label}")
            activity.log(
                "discovering",
                f"Store finder: {label}",
                detail=(
                    f"Target {args.max_results} stores · "
                    f"{'independent stores only' if args.independent_only else 'chains included'} · "
                    f"budget {args.max_requests} Maps requests (~${args.max_requests * PLACES_COST_PER_REQUEST:.2f} max)"
                ),
            )
            print(f"Store finder: {label}", flush=True)
            memory = StoreSearchMemory()
            try:
                rows, shortfall = discover_stores(
                    store_keys,
                    locations,
                    args.max_results,
                    maps_key,
                    independent_only=args.independent_only,
                    max_requests=args.max_requests,
                    erp=erp,
                    progress=progress,
                    activity=activity,
                    zip_radius_miles=max(0.0, min(50.0, args.zip_radius)),
                    memory=memory,
                )
                if not rows:
                    # Nothing new to lose: still move past the pages just read.
                    memory.commit()
                progress.discovered_urls = [row.get("website") or row["business_name"] for row in rows]
                progress.total = len(rows)
                _finish_run(
                    args, deduplicate_leads(rows), progress, activity, len(rows), erp,
                    target=args.max_results, shortfall=shortfall,
                )
                memory.commit()
            finally:
                memory.close()
            return 0

        # Google Maps (Places API) discovery is a self-contained branch: it
        # returns finished lead rows (business/phone/website/address), including
        # businesses with no website, then joins the shared enrich → save →
        # webhook path below. It does not use the LLM website scraper at all.
        if args.source == "maps" and not query:
            raise ValueError("--source maps needs --query.")
        if query and args.source == "maps":
            maps_key = require_maps_api_key()
            progress.update("discovering", message=f"Searching Google Maps for {query}")
            activity.log("discovering", f"Searching Google Maps for “{query}”")
            print(f"Searching Google Maps for: {query}", flush=True)
            # Over-fetch when ERPNext duplicates will be dropped, so the run can
            # still reach the lead target with new businesses only.
            fetch_limit = args.max_results
            if erp is not None and erp.skip_existing:
                fetch_limit = min(60, args.max_results * 3)
            rows = discover_from_places(query, fetch_limit, maps_key)
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
            rows = _skip_existing(erp, deduplicate_leads(rows), activity)[: args.max_results]
            for row in rows:
                # Enrichment reads _source_url; point it at the site when there is
                # one so we still pull email/extra phone, and log the find.
                row["_source_url"] = row.get("website", "")
                activity.log("lead_found", f"Found lead: {row.get('business_name') or 'a business'}")
            _finish_run(args, rows, progress, activity, processed_sources, erp)
            return 0

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

        # Websites ERPNext already has are skipped before paying to scrape them.
        if erp is not None and erp.skip_existing:
            known = [url for url in urls if erp.has_website(url)]
            if known:
                urls = [url for url in urls if not erp.has_website(url)]
                erp.skipped += len(known)
                activity.log(
                    "erpnext",
                    f"Skipped {len(known)} website(s) already in ERP",
                    detail=", ".join(_hostname(url) for url in known[:8]),
                )
                print(f"Skipped {len(known)} website(s) already in ERP.", flush=True)
            if not urls:
                _finish_run(args, [], progress, activity, len(known), erp)
                return 0
        # Crawl4AI does the crawling; OpenAI (when its key works) only reviews
        # each crawled site's text, so a missing/invalid key no longer means
        # zero leads.
        ai = LeadAI.from_env(activity)
        print(
            f"Crawling {len(urls)} website(s) with Crawl4AI"
            f"{f' + {ai.model} review' if ai else ''}...",
            flush=True,
        )
        progress.total = len(urls)
        progress.update("running", message="Starting the browser")
        rows, processed_sources = crawl_business_sites(
            urls,
            query,
            target=args.max_results if query else 0,
            progress=progress,
            activity=activity,
            erp=erp,
            ai=ai,
        )

        rows = deduplicate_leads(rows)
        if query:
            rows = rows[: args.max_results]
        _finish_run(args, rows, progress, activity, processed_sources or len(urls), erp)
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
