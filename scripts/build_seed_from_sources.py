import argparse
import hashlib
import json
import re
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import pdfplumber
from docx import Document
from PIL import Image, ImageDraw, ImageFont


KOREAN_NAME_RE = re.compile(r"^[가-힣]{2,5}[A-Za-z0-9]?$")
TITLE_WORDS = [
    "권사님",
    "집사님",
    "성도님",
    "장로님",
    "목사님",
    "전도사님",
    "권사",
    "집사",
    "성도",
    "장로",
    "목사",
    "전도사",
    "간사",
    "청년",
    "새가족",
]


def normalize_ws(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def clean_name(value):
    text = str(value or "")
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"\b\d+\b", " ", text)
    for word in TITLE_WORDS:
        text = text.replace(word, " ")
    text = re.sub(r"[^가-힣A-Za-z0-9]+", "", text)
    text = re.sub(r"(?<=[가-힣])(?:\d{2,4}|[A-Za-z])$", "", text)
    return text.strip()


def normalize_title(value):
    text = normalize_ws(value).replace("\xa0", " ")
    if not text or text in {"직분없음", "없음", "-"}:
        return "청년"
    return text


def roster_note(value):
    notes = re.findall(r"\(([^)]*)\)", str(value or ""))
    return ", ".join(normalize_ws(note) for note in notes if normalize_ws(note))


def stable_id(prefix, *parts):
    digest = hashlib.sha1("|".join(str(part or "") for part in parts).encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def js_string(value):
    return json.dumps(value, ensure_ascii=False)


def sql_quote(value):
    return "'" + str(value or "").replace("'", "''") + "'"


def crop_text(page, x0, top, x1, bottom):
    cropped = page.crop((x0, top, x1, bottom))
    return normalize_ws(cropped.extract_text(x_tolerance=2, y_tolerance=4) or "")


def text_lines_in_box(page, x0, top, x1, bottom):
    words = [
        word
        for word in page.extract_words(x_tolerance=2, y_tolerance=4)
        if word["x0"] >= x0 and word["x1"] <= x1 and word["top"] >= top and word["bottom"] <= bottom
    ]
    by_line = defaultdict(list)
    for word in words:
        key = round(word["top"] / 3) * 3
        by_line[key].append(word)
    lines = []
    for key in sorted(by_line):
        line = "".join(word["text"] for word in sorted(by_line[key], key=lambda item: item["x0"]))
        line = normalize_ws(line)
        if line:
            lines.append(line)
    return lines


def extract_text_lines(page):
    words = page.extract_words(x_tolerance=2, y_tolerance=4)
    by_line = defaultdict(list)
    for word in words:
        key = round(word["top"] / 3) * 3
        by_line[key].append(word)
    lines = []
    for key in sorted(by_line):
        items = sorted(by_line[key], key=lambda item: item["x0"])
        lines.append(
            {
                "top": min(item["top"] for item in items),
                "bottom": max(item["bottom"] for item in items),
                "x0": min(item["x0"] for item in items),
                "x1": max(item["x1"] for item in items),
                "words": items,
                "text": " ".join(item["text"] for item in items),
            }
        )
    return lines


def parse_roster_title(text):
    match = re.search(r"청년\s*(\d+)\s*셀\s*(?:\(([^)]*)\))?", text or "")
    if not match:
        return None
    number = int(match.group(1))
    meta = normalize_ws(match.group(2) or "")
    gender = "남자" if "형제" in meta else "여자" if "자매" in meta else ""
    return {
        "number": number,
        "id": f"cell-{number}",
        "name": f"청년 {number}셀",
        "meta": meta,
        "gender": gender,
        "sortOrder": number * 10,
    }


def line_under_image(lines, image):
    candidates = []
    image_center = (image["x0"] + image["x1"]) / 2
    for line in lines:
        if line["top"] < image["bottom"] + 3 or line["top"] > image["bottom"] + 45:
            continue
        if line["x1"] < image["x0"] - 20 or line["x0"] > image["x1"] + 20:
            continue
        # Keep only words that belong to the same visual card. This also keeps
        # spaced names like "박 민" together when the source PDF separates them.
        words = [
            word
            for word in line["words"]
            if image["x0"] - 14 <= ((word["x0"] + word["x1"]) / 2) <= image["x1"] + 14
        ]
        if not words:
            continue
        text = " ".join(word["text"] for word in words)
        center_distance = abs(((min(word["x0"] for word in words) + max(word["x1"] for word in words)) / 2) - image_center)
        candidates.append((line["top"] - image["bottom"], center_distance, text))
    if not candidates:
        return ""
    candidates.sort(key=lambda item: (item[0], item[1]))
    return normalize_ws(candidates[0][2])


def parse_roster_label(label):
    text = normalize_ws(label)
    role = ""
    for role_label, role_value in [
        ("부셀장", "assistant_leader"),
        ("기도장", "prayer_leader"),
        ("셀장", "cell_leader"),
    ]:
        if text.startswith(role_label):
            role = role_value
            text = normalize_ws(text[len(role_label):])
            break
    name = clean_name(text)
    note = roster_note(text)
    if name in {"부제", "부재", "없음", "직분없음"}:
        return "", "", ""
    return name, role, note


def extract_youth_roster_members(pdf_path):
    members = []
    cells_by_id = {}
    with pdfplumber.open(pdf_path) as pdf:
        for page_index, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            cell = parse_roster_title(text)
            if not cell:
                continue
            cells_by_id[cell["id"]] = cell
            lines = extract_text_lines(page)
            page_images = [
                image for image in page.images
                if image["top"] > 35 and image["width"] > 25 and image["height"] > 25
            ]
            page_images.sort(key=lambda item: (item["top"], item["x0"]))
            seen_names = defaultdict(int)
            for image_index, image in enumerate(page_images, 1):
                label = line_under_image(lines, image)
                name, role, note = parse_roster_label(label)
                if not name:
                    continue
                seen_names[name] += 1
                memo = f"요람 메모: {note}" if note else ""
                members.append(
                    {
                        "source": "youth-roster-pdf",
                        "cellNumber": cell["number"],
                        "cellId": cell["id"],
                        "cellName": cell["name"],
                        "rowNumber": image_index,
                        "name": name,
                        "title": "청년",
                        "role": role,
                        "prayerRequests": "",
                        "memo": memo,
                        "image": {
                            "page": page_index + 1,
                            "x0": image["x0"],
                            "top": image["top"],
                            "x1": image["x1"],
                            "bottom": image["bottom"],
                        },
                    }
                )
    return members, [cells_by_id[key] for key in sorted(cells_by_id, key=lambda item: int(item.split("-")[1]))]


def find_title_for_table(page, table_top):
    title_text = crop_text(page, 120, max(0, table_top - 60), 470, table_top)
    match = re.search(r"청년공동체\s*(\d+)\s*셀", title_text)
    return int(match.group(1)) if match else None


def table_boxes(page):
    boxes = []
    for line in page.lines:
        if abs(line["width"]) > 1:
            continue
        if abs(line["x0"] - 43.9) > 2:
            continue
        if line["bottom"] - line["top"] < 100:
            continue
        top = round(line["top"], 1)
        bottom = round(line["bottom"], 1)
        if (top, bottom) not in boxes:
            boxes.append((top, bottom))
    return sorted(set(boxes))


def full_width_boundaries(page, top, bottom):
    ys = set()
    for line in page.lines:
        if abs(line["height"]) > 1:
            continue
        y = round(line["top"], 1)
        if y < top - 1 or y > bottom + 1:
            continue
        # Full table boundaries cross all columns. Some row boundaries are split
        # at the name/prayer divider; the left segment is enough to identify them.
        if line["x0"] <= 45 and line["x1"] >= 159:
            ys.add(y)
    ys.add(round(top, 1))
    ys.add(round(bottom, 1))
    return sorted(ys)


def extract_name_from_row(page, top, bottom):
    lines = text_lines_in_box(page, 84, top, 160.8, bottom + 2)
    candidates = []
    for line in lines:
        cleaned = clean_name(line)
        if KOREAN_NAME_RE.match(cleaned):
            candidates.append(cleaned)
    return candidates[-1] if candidates else ""


def extract_number_from_row(page, top, bottom):
    text = crop_text(page, 43, top + 3, 84, bottom - 3)
    match = re.search(r"\d+", text)
    return int(match.group(0)) if match else 0


def extract_cell_members(pdf_path):
    members = []
    images = []
    current_cell = None

    with pdfplumber.open(pdf_path) as pdf:
        for page_index, page in enumerate(pdf.pages):
            for table_top, table_bottom in table_boxes(page):
                title_cell = find_title_for_table(page, table_top)
                if title_cell:
                    current_cell = title_cell
                if not current_cell:
                    continue

                boundaries = full_width_boundaries(page, table_top, table_bottom)
                if len(boundaries) < 3:
                    continue

                for row_top, row_bottom in zip(boundaries[1:-1], boundaries[2:]):
                    name = extract_name_from_row(page, row_top, row_bottom)
                    if not name:
                        continue
                    prayer = crop_text(page, 160, row_top + 2, 528, row_bottom - 2)
                    prayer = re.sub(r"(?<=\D)(\d+)\s*\.\s*", r"\n\1. ", prayer)
                    prayer = normalize_ws(prayer).replace(" .", ".")
                    number = extract_number_from_row(page, row_top, row_bottom)
                    image = None
                    for item in page.images:
                        center_y = (item["top"] + item["bottom"]) / 2
                        center_x = (item["x0"] + item["x1"]) / 2
                        if 84 <= center_x <= 160 and row_top <= center_y <= row_bottom:
                            image = {
                                "page": page_index + 1,
                                "x0": item["x0"],
                                "top": item["top"],
                                "x1": item["x1"],
                                "bottom": item["bottom"],
                            }
                            break
                    member = {
                        "source": "photo-pdf",
                        "cellNumber": current_cell,
                        "cellId": f"cell-{current_cell}",
                        "cellName": f"청년공동체 {current_cell}셀",
                        "rowNumber": number,
                        "name": name,
                        "title": "",
                        "role": "",
                        "prayerRequests": prayer,
                        "image": image,
                    }
                    members.append(member)
                    if image:
                        images.append((len(members) - 1, image))
    return members, images


def save_member_photos(pdf_path, members, output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    for old_photo in output_dir.glob("seed-*.jpg"):
        old_photo.unlink()
    for page_number in sorted({m["image"]["page"] for m in members if m.get("image")}):
        with pdfplumber.open(pdf_path) as pdf:
            page = pdf.pages[page_number - 1]
            rendered = page.to_image(resolution=260).original.convert("RGB")
            scale_x = rendered.width / page.width
            scale_y = rendered.height / page.height
            for index, member in enumerate(members):
                image = member.get("image")
                if not image or image["page"] != page_number:
                    continue
                pad = 4
                left = max(0, int((image["x0"] - pad) * scale_x))
                top = max(0, int((image["top"] - pad) * scale_y))
                right = min(rendered.width, int((image["x1"] + pad) * scale_x))
                bottom = min(rendered.height, int((image["bottom"] + pad) * scale_y))
                cropped = rendered.crop((left, top, right, bottom))
                cropped.thumbnail((420, 420), Image.Resampling.LANCZOS)
                seed_id = member["id"]
                out_path = output_dir / f"{seed_id}.jpg"
                cropped.save(out_path, quality=88, optimize=True)
    for member in members:
        out_path = output_dir / f"{member['id']}.jpg"
        if out_path.exists():
            continue
        save_placeholder_photo(member["name"], out_path)


def save_placeholder_photo(name, out_path):
    image = Image.new("RGB", (420, 420), "#eef2f7")
    draw = ImageDraw.Draw(image)
    draw.ellipse((58, 52, 362, 356), fill="#d8dee8")
    draw.ellipse((148, 96, 272, 220), fill="#ffffff")
    draw.rounded_rectangle((102, 238, 318, 340), radius=54, fill="#ffffff")
    initials = "".join(list(str(name or "성도").replace(" ", ""))[-2:])
    font = None
    for font_path in [
        "C:/Windows/Fonts/malgunbd.ttf",
        "C:/Windows/Fonts/malgun.ttf",
        "C:/Windows/Fonts/NanumGothicBold.ttf",
    ]:
        try:
            font = ImageFont.truetype(font_path, 72)
            break
        except OSError:
            continue
    if font:
        bbox = draw.textbbox((0, 0), initials, font=font)
        draw.text(
            ((420 - (bbox[2] - bbox[0])) / 2, 348),
            initials,
            fill="#475569",
            font=font,
        )
    image.save(out_path, quality=88, optimize=True)


def parse_person_header(value):
    text = normalize_ws(value).replace("\xa0", " ")
    match = re.match(r"(.+?)\s*\((.*?)\)\s*([남여])?$", text)
    if not match:
        return clean_name(text), "청년", ""
    name = clean_name(match.group(1))
    title = normalize_title(match.group(2))
    gender = "남자" if match.group(3) == "남" else "여자" if match.group(3) == "여" else ""
    return name, title, gender


def first_nonempty(*values):
    for value in values:
        text = normalize_ws(value).replace("\xa0", " ")
        if text and text.lower() != "nan":
            return text
    return ""


def split_contact(value):
    text = normalize_ws(value).replace("\xa0", " ")
    parts = [normalize_ws(part) for part in re.split(r"[,/]", text) if normalize_ws(part)]
    phones = [part for part in parts if re.search(r"\d", part)]
    mobile = next((part for part in phones if part.replace("-", "").startswith("010")), "")
    home = next((part for part in phones if part != mobile), "")
    return mobile, home


def parse_excel_members(path):
    df = pd.read_excel(path, dtype=str, keep_default_na=False)
    df = df.fillna("")
    columns = list(df.columns)

    starts = []
    for idx, row in df.iterrows():
        number = normalize_ws(row.get(columns[0], ""))
        label = normalize_ws(row.get(columns[2], "")) if len(columns) > 2 else ""
        if number.isdigit() and "이름" in label:
            starts.append(idx)

    people = []
    for pos, start in enumerate(starts):
        end = starts[pos + 1] if pos + 1 < len(starts) else len(df)
        block = df.iloc[start:end]
        first = block.iloc[0]
        name, title, gender = parse_person_header(first.get(columns[3], ""))
        if not name:
            continue
        record = {
            "excelNumber": normalize_ws(first.get(columns[0], "")),
            "name": name,
            "title": title,
            "gender": gender,
            "cellName": "",
            "phone": "",
            "homePhone": "",
            "birth": "",
            "registeredAt": "",
            "address": "",
            "family": [],
            "memoParts": [],
        }

        spouse = first_nonempty(first.get(columns[5], "") if len(columns) > 5 else "")
        if spouse:
            record["family"].append(f"배우자: {spouse}")
        household = first_nonempty(first.get(columns[7], "") if len(columns) > 7 else "")
        if household:
            household_parts = [household]
            for _, extra_row in block.iloc[1:3].iterrows():
                extra = first_nonempty(extra_row.get(columns[7], "") if len(columns) > 7 else "")
                if extra:
                    household_parts.append(extra)
            record["family"].append("신앙세대주: " + " ".join(household_parts))

        for _, row in block.iterrows():
            row_values = [first_nonempty(row.get(col, "")) for col in columns]
            for col_index, label in enumerate(row_values):
                if not label:
                    continue
                next_value = first_nonempty(*row_values[col_index + 1 : col_index + 3])
                if "생년월일" in label and next_value:
                    record["birth"] = next_value
                elif label == "연락처" and next_value:
                    record["phone"], record["homePhone"] = split_contact(next_value)
                elif label == "등록일" and next_value:
                    match = re.search(r"\d{4}-\d{2}-\d{2}", next_value)
                    record["registeredAt"] = match.group(0) if match else next_value
                elif label == "주소" and next_value:
                    record["address"] = next_value
                elif label in {"인도자", "교인구분", "구역", "셀", "기타사항", "최종심방일"} and next_value:
                    cell_match = re.search(r"청년\s*(\d+)\s*셀", next_value)
                    if cell_match:
                        record["cellName"] = f"청년공동체 {int(cell_match.group(1))}셀"
                    if label not in {"구역", "셀"} or next_value != "청년셀":
                        record["memoParts"].append(f"{label}: {next_value}")
        people.append(record)
    return people


def merge_excel_details(members, excel_people):
    by_name = defaultdict(list)
    for person in excel_people:
        by_name[clean_name(person["name"])].append(person)

    for member in members:
        candidates = by_name.get(clean_name(member["name"]), [])
        if len(candidates) > 1:
            cell_candidates = [person for person in candidates if person.get("cellName") == member.get("cellName")]
            if len(cell_candidates) == 1:
                candidates = cell_candidates
        if len(candidates) != 1:
            member["excelMatchCount"] = len(candidates)
            continue
        detail = candidates[0]
        member["title"] = normalize_title(detail.get("title") or member.get("title", ""))
        member["phone"] = detail.get("phone", "")
        member["homePhone"] = detail.get("homePhone", "")
        member["birth"] = detail.get("birth", "")
        member["registeredAt"] = detail.get("registeredAt", "")
        member["address"] = detail.get("address", "")
        memo_parts = []
        if detail.get("gender"):
            memo_parts.append(f"성별: {detail['gender']}")
        memo_parts.extend(detail.get("family", []))
        memo_parts.extend(detail.get("memoParts", []))
        existing_memo = normalize_ws(member.get("memo", ""))
        if existing_memo:
            memo_parts.insert(0, existing_memo)
        member["memo"] = "\n".join(dict.fromkeys(part for part in memo_parts if part))
        member["excelNumber"] = detail.get("excelNumber", "")
        member["excelMatchCount"] = 1


def docx_to_text(docx_path, txt_path):
    document = Document(docx_path)
    text = "\n".join(paragraph.text for paragraph in document.paragraphs)
    txt_path.write_text(text, encoding="utf-8")


def write_members_for_visit_import(members, path):
    payload = {
        "results": [
            {
                "id": member["id"],
                "name": member["name"],
                "title": member.get("title", ""),
                "role": member.get("role", ""),
                "cellName": member["cellName"],
                "archivedAt": "",
            }
            for member in members
        ]
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def read_visit_csv(csv_path):
    if not csv_path.exists():
        return []
    df = pd.read_csv(csv_path, dtype=str, keep_default_na=False)
    visits = []
    for _, row in df.iterrows():
        if row.get("status") != "ready":
            continue
        visits.append(
            {
                "id": row.get("visitId", ""),
                "memberId": row.get("memberId", ""),
                "visitDate": row.get("visitDate", ""),
                "visitType": row.get("visitType", "전화") or "전화",
                "summary": row.get("summary", ""),
                "prayer": row.get("prayer", ""),
                "action": "",
                "source": row.get("source", "docx-import") or "docx-import",
                "createdAt": row.get("createdAt", ""),
            }
        )
    return visits


def merge_prayer_requests(members, prayer_pdf_path):
    if not prayer_pdf_path:
        return
    prayer_members, _ = extract_cell_members(prayer_pdf_path)
    prayers_by_name = {}
    for prayer_member in prayer_members:
        name = clean_name(prayer_member.get("name", ""))
        prayer = normalize_ws(prayer_member.get("prayerRequests", ""))
        if name and prayer and name not in prayers_by_name:
            prayers_by_name[name] = prayer
    for member in members:
        member["prayerRequests"] = prayers_by_name.get(clean_name(member["name"]), member.get("prayerRequests", ""))


def write_seed_data_js(cells, members, visits, output_path):
    payload_cells = [
        {
            "id": cell["id"],
            "name": cell["name"],
            "meta": cell.get("meta", ""),
            "gender": cell.get("gender", ""),
            "sortOrder": cell["sortOrder"],
        }
        for cell in cells
    ]
    payload_members = []
    for member in members:
        payload_members.append(
            {
                "id": member["id"],
                "cellId": member["cellId"],
                "name": member["name"],
                "title": member.get("title", ""),
                "role": member.get("role", ""),
                "phone": member.get("phone", ""),
                "homePhone": member.get("homePhone", ""),
                "birth": member.get("birth", ""),
                "registeredAt": member.get("registeredAt", ""),
                "baptized": True,
                "address": member.get("address", ""),
                "memo": member.get("memo", ""),
                "prayerRequests": member.get("prayerRequests", ""),
                "photoUrl": f"photos/{member['id']}.jpg?v=20260707-source",
                "photoKey": "",
                "photoRemoved": False,
                "archivedAt": "",
                "trashedAt": "",
                "createdAt": "2026-07-07T00:00:00.000Z",
                "updatedAt": "2026-07-07T00:00:00.000Z",
            }
        )
    output = [
        "// Generated from local church source files. Do not commit to a public repository.",
        f"window.SEED_DATA_VERSION = {js_string('2026-07-07-youth-roster-1')};",
        f"window.SEED_COMMUNITY_TITLE = {js_string('청년공동체 목양웹')};",
        f"window.SEED_CELLS = {json.dumps(payload_cells, ensure_ascii=False, indent=2)};",
        f"window.SEED_MEMBERS = {json.dumps(payload_members, ensure_ascii=False, indent=2)};",
        f"window.SEED_VISITS = {json.dumps(visits, ensure_ascii=False, indent=2)};",
        "",
    ]
    output_path.write_text("\n".join(output), encoding="utf-8")


def write_seed_migration(cells, members, visits, output_path):
    lines = [
        "-- Generated from local church source files. Do not commit to a public repository.",
        "DELETE FROM visit_notes WHERE source IN ('docx-import', 'google-docs-2026-visit-log');",
        "DELETE FROM members WHERE id LIKE 'seed-%';",
        "DELETE FROM cells WHERE id IN ('male-8', 'male-16', 'female-3', 'female-9', 'female-15', 'female-25', 'female-33');",
        "DELETE FROM cells WHERE id LIKE 'cell-%';",
        "",
    ]
    for cell in cells:
        lines.append(
            "INSERT OR REPLACE INTO cells (id, name, meta, gender, sort_order) VALUES "
            f"({sql_quote(cell['id'])}, {sql_quote(cell['name'])}, {sql_quote(cell.get('meta', ''))}, "
            f"{sql_quote(cell.get('gender', ''))}, {int(cell['sortOrder'])});"
        )
    lines.append("")
    for member in members:
        values = [
            member["id"],
            member["cellId"],
            member["name"],
            member.get("title", ""),
            member.get("role", ""),
            member.get("phone", ""),
            member.get("homePhone", ""),
            member.get("birth", ""),
            member.get("registeredAt", ""),
            member.get("address", ""),
            member.get("memo", ""),
            member.get("prayerRequests", ""),
            1,
            0,
            f"{member['id']}.jpg",
            "",
            "",
            "2026-07-07T00:00:00.000Z",
            "2026-07-07T00:00:00.000Z",
        ]
        lines.append(
            "INSERT OR REPLACE INTO members "
            "(id, cell_id, name, title, role, phone, home_phone, birth, registered_at, address, memo, "
            "prayer_requests, baptized, long_absent, photo_key, archived_at, trashed_at, created_at, updated_at) "
            f"VALUES ({', '.join(sql_quote(value) if not isinstance(value, int) else str(value) for value in values)});"
        )
    lines.append("")
    for visit in visits:
        values = [
            visit["id"],
            visit["memberId"],
            visit["visitDate"],
            visit["visitType"],
            visit["summary"],
            visit.get("prayer", ""),
            visit.get("action", ""),
            visit.get("source", "docx-import"),
            "",
            visit.get("createdAt") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        ]
        lines.append(
            "INSERT OR IGNORE INTO visit_notes "
            "(id, member_id, visit_date, visit_type, summary, prayer, action, source, raw_payload, created_at) "
            f"VALUES ({', '.join(sql_quote(value) for value in values)});"
        )
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_summary(cells, members, excel_people, visits, output_path):
    summary = {
        "cells": len(cells),
        "members": len(members),
        "membersWithExcelDetails": sum(1 for member in members if member.get("excelMatchCount") == 1),
        "membersWithoutExcelDetails": [
            member["name"] for member in members if member.get("excelMatchCount") != 1
        ],
        "excelPeople": len(excel_people),
        "membersWithPhotos": sum(1 for member in members if member.get("image")),
        "visits": len(visits),
        "cellCounts": {
            cell["name"]: sum(1 for member in members if member["cellId"] == cell["id"])
            for cell in cells
        },
    }
    output_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--roster-pdf")
    parser.add_argument("--photo-pdf")
    parser.add_argument("--prayer-pdf")
    parser.add_argument("--excel", required=True)
    parser.add_argument("--docx", required=True)
    parser.add_argument("--work-dir", default="tmp/source_extract")
    parser.add_argument("--public-dir", default="public")
    parser.add_argument("--migration", default="migrations/0012_seed_church_data.sql")
    args = parser.parse_args()

    work_dir = Path(args.work_dir)
    public_dir = Path(args.public_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    roster_pdf = args.roster_pdf or args.photo_pdf
    if not roster_pdf:
        parser.error("--roster-pdf is required")

    if args.roster_pdf:
        members, cells = extract_youth_roster_members(roster_pdf)
    else:
        members, _ = extract_cell_members(roster_pdf)
        cells = [
            {
                "id": f"cell-{number}",
                "name": f"청년공동체 {number}셀",
                "meta": "2026년 청년공동체",
                "gender": "",
                "sortOrder": number * 10,
            }
            for number in sorted({member["cellNumber"] for member in members})
        ]
    members = sorted(members, key=lambda item: (item["cellNumber"], item["rowNumber"], item["name"]))
    for index, member in enumerate(members, 1):
        member["id"] = f"seed-{index:03d}"
        member["title"] = normalize_title(member.get("title", ""))
        member.setdefault("phone", "")
        member.setdefault("homePhone", "")
        member.setdefault("birth", "")
        member.setdefault("registeredAt", "")
        member.setdefault("address", "")
        member.setdefault("memo", "")

    excel_people = parse_excel_members(args.excel)
    merge_excel_details(members, excel_people)
    merge_prayer_requests(members, args.prayer_pdf)

    photos_dir = public_dir / "photos"
    save_member_photos(roster_pdf, members, photos_dir)

    visit_text_path = work_dir / "visit_notes.txt"
    docx_to_text(args.docx, visit_text_path)
    members_for_visit_path = work_dir / "members_for_visit_import.json"
    write_members_for_visit_import(members, members_for_visit_path)

    seed_js_path = public_dir / "seed-data.js"
    visit_csv_path = work_dir / "visit_import.csv"
    visits = read_visit_csv(visit_csv_path)
    write_seed_data_js(cells, members, visits, seed_js_path)
    write_seed_migration(cells, members, visits, Path(args.migration))
    write_summary(cells, members, excel_people, visits, work_dir / "summary.json")

    print(
        json.dumps(
            {
                "members": len(members),
                "cells": len(cells),
                "excelPeople": len(excel_people),
                "membersForVisitImport": str(members_for_visit_path),
                "visitText": str(visit_text_path),
                "visitCsv": str(visit_csv_path),
                "seedData": str(seed_js_path),
                "migration": args.migration,
                "summary": str(work_dir / "summary.json"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
