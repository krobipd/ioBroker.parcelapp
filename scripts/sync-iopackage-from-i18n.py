#!/usr/bin/env python3
"""
sync-iopackage-from-i18n.py — io-package.json:instanceObjects-Strings aus
src/lib/i18n-states.ts deterministisch synchronisieren.

i18n-states.ts ist single-source-of-truth, die common.name/desc-Blocks in
io-package.json werden bei jedem Release neu aus i18n-states.ts gerendert.

Aufruf:
    python3 scripts/sync-iopackage-from-i18n.py [--check]

    --check   nur prüfen ob synchron (exit 1 bei Drift), nicht schreiben.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import OrderedDict
from pathlib import Path

LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"]

# Mapping: io-package.json instanceObjects._id  →  i18n-states.ts STATE_NAMES-Key
NAME_MAPPING = {
    "info": "info",
    "info.connection": "infoConnection",
    "deliveries": "deliveries",
    "summary": "summary",
}

# Mapping: io-package.json instanceObjects._id  →  i18n-states.ts STATE_DESCS-Key
DESC_MAPPING = {}


def parse_ts_dict(text: str, dict_name: str) -> dict[str, dict[str, str]]:
    """Parse `export const <dict_name>: Record<string, StateName> = { ... };`.

    Returns mapping {top_level_key: {lang_code: value}}.
    """
    block_match = re.search(
        rf"export const {dict_name}[^=]*=\s*\{{(.*?)^\}};",
        text,
        re.DOTALL | re.MULTILINE,
    )
    if not block_match:
        return {}
    block = block_match.group(1)

    result: dict[str, dict[str, str]] = {}
    for key_match in re.finditer(
        r"^  ['\"]?([a-zA-Z][a-zA-Z0-9-_]*)['\"]?\s*:\s*\{(.*?)^  \},?",
        block,
        re.DOTALL | re.MULTILINE,
    ):
        key = key_match.group(1)
        inner = key_match.group(2)
        langs: dict[str, str] = {}
        for lang_match in re.finditer(
            r"^\s*['\"]?([a-z]{2}(?:-[a-z]{2})?)['\"]?\s*:\s*(['\"])(.*?)\2\s*,?\s*$",
            inner,
            re.MULTILINE,
        ):
            lang = lang_match.group(1)
            val = lang_match.group(3)
            if lang in LANGS:
                langs[lang] = val
        if langs:
            result[key] = langs
    return result


def build_translation_object(langs: dict[str, str]) -> "OrderedDict[str, str]":
    """Build a translation object in the canonical io-package.json language order."""
    out: OrderedDict[str, str] = OrderedDict()
    for lang in LANGS:
        if lang in langs:
            out[lang] = langs[lang]
    return out


def sync_field(
    instance_objects_list: list,
    ts_dict: dict[str, dict[str, str]],
    mapping: dict[str, str],
    field_name: str,
) -> tuple[int, list[str]]:
    """Update `common.<field_name>` in each instanceObjects entry to match the
    TS dict. Returns (changes_count, error_list)."""
    changes = 0
    errors: list[str] = []
    by_id = {x["_id"]: x for x in instance_objects_list if isinstance(x, dict) and "_id" in x}

    for io_id, i18n_key in mapping.items():
        if io_id not in by_id:
            errors.append(f"instanceObjects missing _id={io_id}")
            continue
        if i18n_key not in ts_dict:
            errors.append(f"i18n-states.ts missing key={i18n_key} (mapped for {io_id})")
            continue
        ts_obj = build_translation_object(ts_dict[i18n_key])
        common = by_id[io_id].setdefault("common", OrderedDict())
        if not isinstance(common, dict):
            errors.append(f"{io_id}.common is not a dict")
            continue
        existing = common.get(field_name)
        if isinstance(existing, dict) and dict(existing) == dict(ts_obj):
            continue
        common[field_name] = ts_obj
        changes += 1
    return changes, errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="Read-only: exit 1 if drift, no write")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    iopkg_path = repo_root / "io-package.json"
    i18n_path = repo_root / "src" / "lib" / "i18n-states.ts"

    if not iopkg_path.is_file():
        print(f"ERROR: io-package.json not found at {iopkg_path}")
        return 1
    if not i18n_path.is_file():
        print(f"ERROR: i18n-states.ts not found at {i18n_path}")
        return 1

    iopkg = json.loads(iopkg_path.read_text(encoding="utf-8"), object_pairs_hook=OrderedDict)
    i18n_text = i18n_path.read_text(encoding="utf-8")

    state_names = parse_ts_dict(i18n_text, "STATE_NAMES")
    state_descs = parse_ts_dict(i18n_text, "STATE_DESCS")

    if not state_names:
        print("ERROR: could not parse STATE_NAMES from i18n-states.ts")
        return 1

    instance_objects = iopkg.get("instanceObjects", [])
    if not isinstance(instance_objects, list):
        print("ERROR: io-package.json:instanceObjects is not a list")
        return 1

    name_changes, name_errors = sync_field(instance_objects, state_names, NAME_MAPPING, "name")
    desc_changes, desc_errors = sync_field(instance_objects, state_descs, DESC_MAPPING, "desc")

    errors = name_errors + desc_errors
    total_changes = name_changes + desc_changes

    if errors:
        for e in errors:
            print(f"  ✗ {e}")
        print(f"\nFAIL: {len(errors)} structural error(s)")
        return 1

    if args.check:
        if total_changes > 0:
            print(f"[sync-iopackage-from-i18n] DRIFT — {total_changes} field(s) out of sync (use without --check to fix)")
            return 1
        print("[sync-iopackage-from-i18n] OK — io-package.json matches i18n-states.ts")
        return 0

    if total_changes == 0:
        print("[sync-iopackage-from-i18n] no changes (already in sync)")
        return 0

    iopkg_path.write_text(json.dumps(iopkg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[sync-iopackage-from-i18n] updated {total_changes} field(s) in io-package.json from i18n-states.ts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
