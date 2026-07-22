#!/usr/bin/env python3
"""
Set up a Retell AI Knowledge Base (managed RAG) for the Cotton Valley Outbound
Sales Agent and attach it to the agent's conversation flow.

What it does:
  1. Creates ONE knowledge base from both company websites
     (universaldc.com + cottonvalley.net), with 12-hour auto-refresh.
  2. Polls until Retell has finished scraping/embedding the URLs.
  3. Attaches the knowledge base to the agent's conversation flow via
     `knowledge_base_ids` so retrieval happens automatically during calls.

Retell handles scraping, chunking, embedding and retrieval — nothing else
(no vector DB, no webhook) is needed on our side.

Usage:
    # RETELL_API_KEY must be in .env (key_...)
    python setup_retell_kb.py            # create + wait + attach
    python setup_retell_kb.py --no-attach   # create KB only, don't touch the agent
    python setup_retell_kb.py --dry-run     # print what it would do, call nothing

Re-running creates a NEW knowledge base each time; to add URLs to the existing
one instead, use the /add-knowledge-base-sources endpoint (see Retell docs).
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import requests

API_BASE = "https://api.retellai.com"

# The live agent's conversation flow (see project memory / n8n workflow).
CONVERSATION_FLOW_ID = "conversation_flow_cd20897c37e8"

KB_NAME = "Cotton Valley + Universal DC"
KB_URLS = [
    "https://www.universaldc.com/",
    "https://www.cottonvalley.net/",
]

# Short instruction the agent gets alongside the KB so it knows when to use it.
KB_INSTRUCTION = (
    "Use this knowledge base to answer caller questions about Cotton Valley and "
    "Universal Distribution — products, categories, company background, ordering "
    "and wholesale details. Only state facts found in the knowledge base; if the "
    "answer isn't there, say you'll follow up rather than guessing."
)


def load_api_key() -> str:
    """Read RETELL_API_KEY from the environment or the local .env file."""
    key = os.environ.get("RETELL_API_KEY")
    if key:
        return key.strip()

    env_path = Path(__file__).with_name(".env")
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line.startswith("RETELL_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")

    sys.exit(
        "ERROR: RETELL_API_KEY not found. Add it to .env as:\n"
        "    RETELL_API_KEY=key_xxxxxxxxxxxxxxxx\n"
        "or export it in your shell."
    )


def headers(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


def create_knowledge_base(api_key: str, dry_run: bool) -> str:
    body = {
        "knowledge_base_name": KB_NAME,
        "knowledge_base_urls": KB_URLS,
        "enable_auto_refresh": True,  # re-scrape every 12h so the agent stays current
    }
    print(f"Creating knowledge base '{KB_NAME}' from:")
    for u in KB_URLS:
        print(f"  - {u}")
    if dry_run:
        print("[dry-run] POST /create-knowledge-base", body)
        return "kb_dryrun"

    r = requests.post(
        f"{API_BASE}/create-knowledge-base", json=body, headers=headers(api_key), timeout=60
    )
    r.raise_for_status()
    data = r.json()
    kb_id = data["knowledge_base_id"]
    print(f"  -> created {kb_id} (status: {data.get('status')})")
    return kb_id


def wait_until_ready(api_key: str, kb_id: str, dry_run: bool, timeout_s: int = 900) -> None:
    """Poll the KB until every source finishes scraping/embedding."""
    if dry_run:
        print("[dry-run] would poll GET /get-knowledge-base until complete")
        return

    print("Waiting for Retell to scrape + embed the sites (can take a few minutes)...")
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        r = requests.get(
            f"{API_BASE}/get-knowledge-base/{kb_id}", headers=headers(api_key), timeout=30
        )
        r.raise_for_status()
        data = r.json()
        sources = data.get("knowledge_base_sources", [])
        statuses = [s.get("status") for s in sources] or [data.get("status")]
        print(f"  status: {statuses}")

        if any(s == "error" for s in statuses):
            sys.exit(f"ERROR: a source failed to process. Full response:\n{data}")
        if statuses and all(s == "complete" for s in statuses):
            print("  -> knowledge base ready.")
            return
        time.sleep(15)

    sys.exit("ERROR: timed out waiting for the knowledge base to finish processing.")


def attach_to_conversation_flow(api_key: str, kb_id: str, dry_run: bool) -> None:
    """Add kb_id to the conversation flow's knowledge_base_ids (preserving any existing)."""
    print(f"Attaching {kb_id} to conversation flow {CONVERSATION_FLOW_ID}...")
    if dry_run:
        print(f"[dry-run] PATCH /update-conversation-flow/{CONVERSATION_FLOW_ID}")
        return

    # Read current flow so we don't clobber existing knowledge bases.
    r = requests.get(
        f"{API_BASE}/get-conversation-flow/{CONVERSATION_FLOW_ID}",
        headers=headers(api_key),
        timeout=30,
    )
    r.raise_for_status()
    existing = r.json().get("knowledge_base_ids") or []
    kb_ids = sorted(set(existing) | {kb_id})

    r = requests.patch(
        f"{API_BASE}/update-conversation-flow/{CONVERSATION_FLOW_ID}",
        json={"knowledge_base_ids": kb_ids},
        headers=headers(api_key),
        timeout=30,
    )
    r.raise_for_status()
    print(f"  -> conversation flow now references: {kb_ids}")
    print(
        "\nNOTE: if this conversation flow is published/pinned to a version, "
        "publish a new version in the Retell dashboard (or via the publish endpoint) "
        "for the live agent to pick up the knowledge base."
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-attach", action="store_true", help="create the KB but don't attach it to the agent")
    ap.add_argument("--dry-run", action="store_true", help="print actions without calling the API")
    args = ap.parse_args()

    api_key = load_api_key()
    kb_id = create_knowledge_base(api_key, args.dry_run)
    wait_until_ready(api_key, kb_id, args.dry_run)

    if args.no_attach:
        print(f"\nDone. Knowledge base {kb_id} created (not attached).")
        print(f"Attach it later with: knowledge_base_ids including '{kb_id}' "
              f"on conversation flow {CONVERSATION_FLOW_ID}.")
        return

    attach_to_conversation_flow(api_key, kb_id, args.dry_run)
    print(f"\nDone. Agent's conversation flow now uses knowledge base {kb_id}.")
    print("Reminder — KB instruction to add to the flow/nodes if desired:")
    print(f"  {KB_INSTRUCTION}")


if __name__ == "__main__":
    main()
