import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import openpyxl


NEW_FAMILY_CELL_ID = "cell-newcomer"
NEW_FAMILY_CELL_NAME = "새가족"
NEW_FAMILY_CELL_META = "최근 등록·정착 대상"
OTHER_CELL_ID = "cell-new-family"
OTHER_CELL_NAME = "기타"
OTHER_CELL_META = "청년부 명부 추가·미분류"


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
    if len(digits) == 11:
        return f"{digits[:3]}-{digits[3:7]}-{digits[7:]}"
    if len(digits) == 10:
        return f"{digits[:3]}-{digits[3:6]}-{digits[6:]}"
    return digits


def normalize_birth(value):
    if value in (None, ""):
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d") + " 양"
    text = str(value).strip()
    match = re.search(r"(\d{4})[-./](\d{1,2})[-./](\d{1,2})", text)
    if not match:
        return text
    return f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d} 양"


def sql_quote(value):
    return "'" + str(value or "").replace("'", "''") + "'"


def read_wrangle_json(path):
    text = Path(path).read_text(encoding="utf-8-sig")
    payload = json.loads(text)
    if isinstance(payload, list):
        return payload[0].get("results", [])
    return payload.get("results", [])


def read_roster_xlsx(path):
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    worksheet = workbook.active
    rows = []
    for row in worksheet.iter_rows(values_only=True):
        if not row:
            continue
        name = compact_name(row[1] if len(row) > 1 else "")
        phone = format_phone(row[2] if len(row) > 2 else "")
        birth = normalize_birth(row[3] if len(row) > 3 else "")
        if not name or not phone:
            continue
        rows.append({
            "name": name,
            "phone": phone,
            "birth": birth,
        })

    by_name = {}
    conflicts = []
    for name, grouped in group_by(rows, "name").items():
        phones = sorted({item["phone"] for item in grouped})
        births = [item["birth"] for item in grouped if item.get("birth")]
        if len(phones) > 1:
            conflicts.append(name)
            continue
        by_name[name] = {
            "name": name,
            "phone": phones[0],
            "birth": births[0] if births else "",
            "sourceRows": len(grouped),
        }
    return rows, by_name, conflicts


def group_by(rows, key):
    grouped = defaultdict(list)
    for row in rows:
        grouped[row[key]].append(row)
    return grouped


def new_member_id(name):
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:12]
    return f"extra-{digest}"


def build_sql(existing_members, roster_by_name):
    existing_by_name = group_by(existing_members, "name")
    statements = [
        "-- Generated from 청년부 명부.xlsx. Contains personal phone numbers; do not commit.",
        f"INSERT INTO cells (id, name, meta, gender, sort_order) VALUES ({sql_quote(NEW_FAMILY_CELL_ID)}, {sql_quote(NEW_FAMILY_CELL_NAME)}, {sql_quote(NEW_FAMILY_CELL_META)}, '', 80) ON CONFLICT(id) DO UPDATE SET name = excluded.name, meta = excluded.meta, gender = excluded.gender, sort_order = excluded.sort_order, updated_at = CURRENT_TIMESTAMP;",
        f"INSERT INTO cells (id, name, meta, gender, sort_order) VALUES ({sql_quote(OTHER_CELL_ID)}, {sql_quote(OTHER_CELL_NAME)}, {sql_quote(OTHER_CELL_META)}, '', 90) ON CONFLICT(id) DO UPDATE SET name = excluded.name, meta = excluded.meta, gender = excluded.gender, sort_order = excluded.sort_order, updated_at = CURRENT_TIMESTAMP;",
    ]
    updates = []
    adds = []
    skipped_duplicate_existing = []

    for name, roster in sorted(roster_by_name.items()):
        matched = existing_by_name.get(name, [])
        if not matched:
            member_id = new_member_id(name)
            adds.append({
                "id": member_id,
                "name": name,
                "phone": roster["phone"],
                "birth": roster.get("birth", ""),
            })
            statements.append(
                "INSERT INTO members "
                "(id, cell_id, name, title, role, phone, home_phone, birth, registered_at, address, memo, prayer_requests, baptized, long_absent, photo_key, archived_at, trashed_at, created_at, updated_at) "
                "VALUES "
                f"({sql_quote(member_id)}, {sql_quote(OTHER_CELL_ID)}, {sql_quote(name)}, '청년', '', {sql_quote(roster['phone'])}, '', {sql_quote(roster.get('birth', ''))}, '', '', '청년부 명부.xlsx에서 추가', '', 1, 0, '', '', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) "
                "ON CONFLICT(id) DO UPDATE SET phone = excluded.phone, birth = CASE WHEN COALESCE(members.birth, '') = '' THEN excluded.birth ELSE members.birth END, updated_at = CURRENT_TIMESTAMP;"
            )
            continue

        if len(matched) > 1:
            skipped_duplicate_existing.append(name)
            continue

        member = matched[0]
        if member.get("phone"):
            continue

        updates.append({
            "id": member["id"],
            "name": name,
            "phone": roster["phone"],
        })
        statements.append(
            "UPDATE members SET "
            f"phone = {sql_quote(roster['phone'])}, "
            "updated_at = CURRENT_TIMESTAMP "
            f"WHERE id = {sql_quote(member['id'])} AND COALESCE(phone, '') = '';"
        )

    return statements, updates, adds, skipped_duplicate_existing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", required=True)
    parser.add_argument("--current-members", required=True)
    parser.add_argument("--out-sql", default="tmp/youth_roster_import/youth_roster_update.sql")
    parser.add_argument("--out-report", default="tmp/youth_roster_import/youth_roster_update_report.json")
    args = parser.parse_args()

    existing_members = read_wrangle_json(args.current_members)
    roster_rows, roster_by_name, roster_conflicts = read_roster_xlsx(args.xlsx)
    statements, updates, adds, skipped_duplicate_existing = build_sql(existing_members, roster_by_name)

    out_sql = Path(args.out_sql)
    out_report = Path(args.out_report)
    out_sql.parent.mkdir(parents=True, exist_ok=True)
    out_report.parent.mkdir(parents=True, exist_ok=True)
    out_sql.write_text("\n".join(statements) + "\n", encoding="utf-8")

    report = {
        "sourceRowsWithPhone": len(roster_rows),
        "uniqueSourceNames": len(roster_by_name),
        "existingActiveMembers": len(existing_members),
        "phoneUpdatesForExistingBlankMembers": len(updates),
        "newMembersToOtherCell": len(adds),
        "skippedDuplicateSourceNames": len(roster_conflicts),
        "skippedDuplicateExistingNames": len(skipped_duplicate_existing),
        "otherCellId": OTHER_CELL_ID,
        "otherCellName": OTHER_CELL_NAME,
        "outSql": str(out_sql),
    }
    out_report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
