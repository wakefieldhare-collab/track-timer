"""One-time migration: push data.json into Firestore at trackTimer/state via REST.

Uses a gcloud access token for wakefield.hare@gmail.com.

Usage:
    python tools/migrate.py
"""

import json
import subprocess
import sys
import urllib.request
import urllib.error
from pathlib import Path

PROJECT = "hare-family-apps"
DOC_PATH = "trackTimer/state"
DATA_PATH = Path(__file__).resolve().parent.parent / "data.json"


def to_firestore_value(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, list):
        return {"arrayValue": {"values": [to_firestore_value(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: to_firestore_value(val) for k, val in v.items()}}}
    raise TypeError(f"Unsupported type: {type(v)}")


def get_access_token():
    result = subprocess.run(
        ["gcloud", "auth", "print-access-token", "--account=wakefield.hare@gmail.com"],
        capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def get_doc(token):
    url = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/{DOC_PATH}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "X-Goog-User-Project": PROJECT,
    })
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def patch_doc(token, fields_obj):
    url = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/{DOC_PATH}"
    body = json.dumps({"fields": fields_obj}).encode()
    req = urllib.request.Request(url, data=body, method="PATCH", headers={
        "Authorization": f"Bearer {token}",
        "X-Goog-User-Project": PROJECT,
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def firestore_value_to_python(v):
    if "nullValue" in v:
        return None
    if "booleanValue" in v:
        return v["booleanValue"]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return v["doubleValue"]
    if "stringValue" in v:
        return v["stringValue"]
    if "arrayValue" in v:
        return [firestore_value_to_python(x) for x in v["arrayValue"].get("values", [])]
    if "mapValue" in v:
        return {k: firestore_value_to_python(val) for k, val in v["mapValue"].get("fields", {}).items()}
    return None


def main():
    raw = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    token = get_access_token()

    existing = get_doc(token)
    current_fields = existing.get("fields", {}) if existing else {}
    current_races = firestore_value_to_python(current_fields.get("races", {"arrayValue": {}})) or []
    existing_ids = {r.get("id") for r in current_races}

    new_races = [r for r in raw.get("races", []) if r.get("id") not in existing_ids]

    merged_races = sorted(
        new_races + current_races,
        key=lambda r: r.get("date", ""),
        reverse=True,
    )

    merged = {
        "runners": raw.get("runners", ["Hanner", "Billie"]),
        "events": raw.get("events", []),
        "races": merged_races,
    }

    fields = {k: to_firestore_value(v) for k, v in merged.items()}
    result = patch_doc(token, fields)
    print(f"Migration complete: merged {len(new_races)} new races, total {len(merged_races)} races.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
