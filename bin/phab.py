#!/usr/bin/env python3
"""Phabricator conduit CLI for the harness agent."""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.parse
import urllib.request

URL = os.environ.get("PHABRICATOR_URL", "https://phabricator.twitter.biz").rstrip("/")
API = f"{URL}/api"
TOKEN = os.environ.get("PHABRICATOR_CONDUIT_TOKEN") or os.environ.get("CONDUIT_TOKEN") or ""


def die(msg: str, code: int = 1) -> None:
    print(f"phab: {msg}", file=sys.stderr)
    raise SystemExit(code)


def call(method: str, params: dict | None = None) -> dict:
    if not TOKEN:
        die("set PHABRICATOR_CONDUIT_TOKEN in harness .env")
    payload = dict(params or {})
    payload["__conduit__"] = {"token": TOKEN}
    body = urllib.parse.urlencode(
        {"params": json.dumps(payload), "output": "json"}
    ).encode()
    req = urllib.request.Request(f"{API}/{method}", data=body)
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    if data.get("error_code"):
        die(f"{data.get('error_code')}: {data.get('error_info')}")
    return data


def parse_d(raw: str) -> int:
    raw = raw.rstrip("/").split("/")[-1]
    m = re.search(r"(\d+)", raw)
    if not m:
        die("need a D number (e.g. D1354783 or URL)")
    return int(m.group(1))


def out(obj) -> None:
    print(json.dumps(obj, indent=2, default=str))


def cmd_whoami(_: list[str]) -> None:
    r = call("user.whoami").get("result") or {}
    out(
        {
            "userName": r.get("userName"),
            "realName": r.get("realName"),
            "primaryEmail": r.get("primaryEmail"),
            "phid": r.get("phid"),
            "uri": r.get("uri"),
        }
    )


def cmd_view(args: list[str]) -> None:
    if not args:
        die("usage: phab view D1354783")
    rid = parse_d(args[0])
    result = call("differential.query", {"ids": [rid]}).get("result") or []
    if not result:
        die(f"D{rid} not found")
    r = result[0]
    out(
        {
            "id": r.get("id"),
            "uri": r.get("uri") or f"{URL}/D{rid}",
            "title": r.get("title"),
            "status": r.get("statusName"),
            "statusCode": r.get("status"),
            "authorPHID": r.get("authorPHID"),
            "summary": r.get("summary"),
            "testPlan": r.get("testPlan"),
            "lineCount": r.get("lineCount"),
            "dateCreated": r.get("dateCreated"),
            "dateModified": r.get("dateModified"),
            "reviewers": r.get("reviewers"),
            "properties": r.get("properties"),
        }
    )


def cmd_status(args: list[str]) -> None:
    if not args:
        die("usage: phab status D1354783")
    rid = parse_d(args[0])
    result = call("differential.query", {"ids": [rid]}).get("result") or []
    if not result:
        die(f"D{rid} not found")
    r = result[0]
    out(
        {
            "id": r.get("id"),
            "title": r.get("title"),
            "status": r.get("statusName"),
            "uri": r.get("uri") or f"{URL}/D{rid}",
        }
    )


def cmd_comments(args: list[str]) -> None:
    if not args:
        die("usage: phab comments D1354783")
    rid = parse_d(args[0])
    data = call(
        "transaction.search",
        {"objectIdentifier": f"D{rid}", "limit": 40},
    )
    rows = (data.get("result") or {}).get("data") or []
    out(
        [
            {
                "type": t.get("type"),
                "authorPHID": t.get("authorPHID"),
                "dateCreated": t.get("dateCreated"),
                "comments": [
                    (c.get("content") or {}).get("raw")
                    if isinstance(c.get("content"), dict)
                    else c.get("content")
                    for c in (t.get("comments") or [])
                ],
            }
            for t in rows
        ]
    )


def cmd_search(args: list[str]) -> None:
    if not args:
        die("usage: phab search <query>")
    q = " ".join(args)
    data = call(
        "differential.revision.search",
        {"constraints": {"query": q}, "limit": 15},
    )
    rows = (data.get("result") or {}).get("data") or []
    out(
        [
            {
                "id": r.get("id"),
                "uri": f"{URL}/D{r.get('id')}",
                "title": (r.get("fields") or {}).get("title"),
                "status": ((r.get("fields") or {}).get("status") or {}).get("name")
                or (r.get("fields") or {}).get("status"),
            }
            for r in rows
        ]
    )


def cmd_raw(args: list[str]) -> None:
    if not args:
        die("usage: phab raw <method> [paramsJson]")
    method = args[0]
    params = json.loads(args[1]) if len(args) > 1 else {}
    out(call(method, params))


def cmd_help(_: list[str]) -> None:
    print(
        """phab — monitor / inspect Differential revisions

  phab whoami
  phab view D1354783
  phab status D1354783
  phab comments D1354783
  phab search <query>
  phab raw <method> [paramsJson]

Env: PHABRICATOR_URL, PHABRICATOR_CONDUIT_TOKEN
"""
    )


def main(argv: list[str]) -> None:
    if not argv or argv[0] in ("-h", "--help", "help"):
        cmd_help([])
        return
    cmd, *rest = argv
    if re.match(r"^D?\d+$", cmd) or "phabricator" in cmd:
        cmd_view([cmd])
        return
    handlers = {
        "whoami": cmd_whoami,
        "view": cmd_view,
        "show": cmd_view,
        "get": cmd_view,
        "status": cmd_status,
        "comments": cmd_comments,
        "search": cmd_search,
        "raw": cmd_raw,
        "help": cmd_help,
    }
    h = handlers.get(cmd)
    if not h:
        die(f"unknown command: {cmd} (try: phab help)")
    h(rest)


if __name__ == "__main__":
    main(sys.argv[1:])
