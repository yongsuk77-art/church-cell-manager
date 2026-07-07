import argparse
import csv
import json
import re
from pathlib import Path


CONTACT_BLOCK_START = "-- BEGIN contacts.csv phone updates"
CONTACT_BLOCK_END = "-- END contacts.csv phone updates"
TITLE_WORDS = [
    "청년부",
    "새가족",
    "청년",
    "성도",
    "집사",
    "권사",
    "장로",
    "목사",
    "전도사",
    "간사",
]


def compact_name(value):
    text = str(value or "")
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = re.sub(r"\d{2,}\s*년?", " ", text)
    text = re.sub(r"[-_/·:]+", " ", text)
    for word in TITLE_WORDS:
        text = text.replace(word, " ")
    korean_parts = re.findall(r"[가-힣]{2,5}", text)
    if korean_parts:
        return korean_parts[-1]
    return re.sub(r"\s+", "", text)


def normalize_phone(value):
    digits = re.sub(r"\D", "", str(value or ""))
    if digits.startswith("82") and len(digits) >= 11:
        digits = "0" + digits[2:]
    if len(digits) > 11:
        digits = digits[-11:]
    return digits


def format_phone(value):
    digits = normalize_phone(value)
    if not digits:
        return ""
    if digits.startswith("010") and len(digits) == 11:
        return f"{digits[:3]}-{digits[3:7]}-{digits[7:]}"
    if len(digits) == 11:
        return f"{digits[:3]}-{digits[3:7]}-{digits[7:]}"
    if len(digits) == 10:
        return f"{digits[:3]}-{digits[3:6]}-{digits[6:]}"
    return digits


def sql_quote(value):
    return "'" + str(value or "").replace("'", "''") + "'"


def load_seed_data(path):
    text = path.read_text(encoding="utf-8")
    members_match = re.search(r"window\.SEED_MEMBERS\s*=\s*(\[.*?\]);\s*window\.SEED_VISITS", text, re.S)
    visits_match = re.search(r"window\.SEED_VISITS\s*=\s*(\[.*?\]);\s*$", text, re.S)
    if not members_match or not visits_match:
        raise ValueError(f"Could not parse seed data from {path}")
    members = json.loads(members_match.group(1))
    visits = json.loads(visits_match.group(1))
    prefix = text[:members_match.start(1)]
    between = text[members_match.end(1):visits_match.start(1)]
    suffix = text[visits_match.end(1):]
    return text, members, visits, prefix, between, suffix


def write_seed_data(path, members, visits):
    output = [
        'window.SEED_DATA_VERSION = "2026-youth-roster-v1";',
        'window.SEED_COMMUNITY_TITLE = "청년공동체 목양웹";',
        f"window.SEED_CELLS = {json.dumps(extract_cells_from_existing(path), ensure_ascii=False, indent=2)};",
        f"window.SEED_MEMBERS = {json.dumps(members, ensure_ascii=False, indent=2)};",
        f"window.SEED_VISITS = {json.dumps(visits, ensure_ascii=False, indent=2)};",
        "",
    ]
    path.write_text("\n".join(output), encoding="utf-8")


def extract_cells_from_existing(path):
    text = path.read_text(encoding="utf-8")
    match = re.search(r"window\.SEED_CELLS\s*=\s*(\[.*?\]);\s*window\.SEED_MEMBERS", text, re.S)
    if not match:
        raise ValueError(f"Could not parse cells from {path}")
    return json.loads(match.group(1))


def load_contacts(path):
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    by_name = {}
    row_count = 0
    for row in rows:
        row_count += 1
        name_fields = [
            row.get("First Name", ""),
            row.get("Middle Name", ""),
            row.get("Last Name", ""),
            row.get("Nickname", ""),
            row.get("File As", ""),
        ]
        name = compact_name(" ".join(part for part in name_fields if part))
        if not name:
            continue

        phones = []
        for key, value in row.items():
            if re.fullmatch(r"Phone \d+ - Value", key or ""):
                phone = format_phone(value)
                if phone and normalize_phone(phone).startswith("010"):
                    phones.append(phone)
        unique_phones = []
        for phone in phones:
            if phone not in unique_phones:
                unique_phones.append(phone)
        if unique_phones:
            by_name.setdefault(name, set()).update(unique_phones)
    return row_count, by_name


def build_updates(members, contact_phones):
    members_by_name = {}
    for member in members:
        members_by_name.setdefault(compact_name(member.get("name", "")), []).append(member)

    updates = []
    skipped_duplicate_member = []
    skipped_duplicate_contact = []
    skipped_no_member = []
    for name, phones in sorted(contact_phones.items()):
        matched_members = members_by_name.get(name, [])
        if not matched_members:
            skipped_no_member.append(name)
            continue
        if len(matched_members) != 1:
            skipped_duplicate_member.append(name)
            continue
        if len(phones) != 1:
            skipped_duplicate_contact.append(name)
            continue
        member = matched_members[0]
        phone = next(iter(phones))
        updates.append({
            "id": member["id"],
            "name": member["name"],
            "oldPhone": member.get("phone", ""),
            "newPhone": phone,
        })
    return updates, {
        "skippedDuplicateMemberNames": skipped_duplicate_member,
        "skippedDuplicateContactNames": skipped_duplicate_contact,
        "skippedNoMemberNames": skipped_no_member,
    }


def write_update_sql(path, updates):
    lines = [
        "-- Generated from local contacts.csv. Contains personal phone numbers; do not commit.",
    ]
    for update in updates:
        lines.append(
            "UPDATE members SET phone = "
            f"{sql_quote(update['newPhone'])}, updated_at = CURRENT_TIMESTAMP "
            f"WHERE id = {sql_quote(update['id'])};"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def patch_seed_migration(path, updates):
    text = path.read_text(encoding="utf-8")
    block_lines = [CONTACT_BLOCK_START]
    for update in updates:
        block_lines.append(
            "UPDATE members SET phone = "
            f"{sql_quote(update['newPhone'])}, updated_at = CURRENT_TIMESTAMP "
            f"WHERE id = {sql_quote(update['id'])};"
        )
    block_lines.append(CONTACT_BLOCK_END)
    block = "\n".join(block_lines)

    pattern = re.compile(
        rf"\n?{re.escape(CONTACT_BLOCK_START)}.*?{re.escape(CONTACT_BLOCK_END)}\n?",
        re.S,
    )
    if pattern.search(text):
        text = pattern.sub("\n" + block + "\n", text)
    else:
        text = text.rstrip() + "\n\n" + block + "\n"
    path.write_text(text, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--contacts", required=True)
    parser.add_argument("--seed-data", default="public/seed-data.js")
    parser.add_argument("--seed-migration", default="migrations/0012_seed_church_data.sql")
    parser.add_argument("--out-sql", default="tmp/source_extract/contacts_phone_update.sql")
    parser.add_argument("--out-report", default="tmp/source_extract/contacts_phone_update_report.json")
    args = parser.parse_args()

    seed_data_path = Path(args.seed_data)
    seed_migration_path = Path(args.seed_migration)
    out_sql_path = Path(args.out_sql)
    out_report_path = Path(args.out_report)
    out_sql_path.parent.mkdir(parents=True, exist_ok=True)
    out_report_path.parent.mkdir(parents=True, exist_ok=True)

    _, members, visits, _, _, _ = load_seed_data(seed_data_path)
    contact_row_count, contact_phones = load_contacts(Path(args.contacts))
    updates, skipped = build_updates(members, contact_phones)

    by_id = {member["id"]: member for member in members}
    for update in updates:
        by_id[update["id"]]["phone"] = update["newPhone"]

    write_seed_data(seed_data_path, members, visits)
    patch_seed_migration(seed_migration_path, updates)
    write_update_sql(out_sql_path, updates)

    report = {
        "contactRows": contact_row_count,
        "contactNamesWithMobile": len(contact_phones),
        "seedMembers": len(members),
        "matchedUniqueNames": len(updates),
        "sameAsSeed": sum(1 for update in updates if update["oldPhone"] == update["newPhone"]),
        "wouldFillBlankInSeed": sum(1 for update in updates if not update["oldPhone"]),
        "wouldChangeSeedPhone": sum(1 for update in updates if update["oldPhone"] and update["oldPhone"] != update["newPhone"]),
        "skippedDuplicateMemberNames": len(skipped["skippedDuplicateMemberNames"]),
        "skippedDuplicateContactNames": len(skipped["skippedDuplicateContactNames"]),
        "skippedNoMemberNames": len(skipped["skippedNoMemberNames"]),
        "updateSql": str(out_sql_path),
    }
    out_report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
