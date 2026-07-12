INSERT INTO cells (id, name, meta, gender, sort_order)
VALUES ('cell-newcomer', '새가족', '최근 등록·정착 대상', '', 80)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  meta = excluded.meta,
  gender = excluded.gender,
  sort_order = excluded.sort_order,
  updated_at = CURRENT_TIMESTAMP;

UPDATE cells
SET name = '기타',
    meta = '청년부 명부 추가·미분류',
    sort_order = 90,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'cell-new-family';

UPDATE sunday_attendance_records
SET cell_name = '기타',
    cell_sort_order = 90,
    updated_at = CURRENT_TIMESTAMP
WHERE cell_id = 'cell-new-family';
