# 심방콜노트 Android 메모함 연동 계약

웹과 Android는 Cloudflare D1의 `notes`를 하나의 원본으로 사용합니다. 앱의 기존 `deviceId`와 `deviceCredential`은 페어링 증명에만 사용하고, 메모 API에는 15분짜리 메모 전용 토큰만 보냅니다.

## 1. 메모 세션 발급

```http
POST /api/integrations/call-note/devices/{deviceId}/memo-session
Authorization: Bearer dvc_v1_...
```

응답의 `accessToken`, `expiresAt`, `expiresInSeconds`, `scopes`, `siteId`, `siteOrigin`, `deviceId`, `generation`을 사용합니다. `accessToken`은 메모리에서 사용하고, 만료 시 Keystore에 보관한 기기 자격증명으로 다시 발급합니다. 관리자 웹 쿠키, FCM 등록 토큰, 메모 토큰을 서로 대신 사용하면 안 됩니다.

이후 요청:

```http
Authorization: Bearer mmo_v1_...
Accept: application/json
```

기기를 해제하거나 새 기기로 교체하면 기존 메모 토큰도 즉시 무효화됩니다.

## 2. 메모 API

| 기능 | 요청 | 동시 수정 방지 |
|---|---|---|
| 목록 | `GET /api/notes` | 없음 |
| 상세 | `GET /api/notes/{noteId}` | 없음 |
| 생성 | `POST /api/notes` | 앱이 만든 UUID를 `id`로 보낼 수 있음 |
| 수정 | `PATCH /api/notes/{noteId}` | JSON의 `expectedRevision` 필수 |
| 삭제 | `DELETE /api/notes/{noteId}` | `If-Match: {revision}` 필수 |
| 사진 추가 | `POST /api/notes/{noteId}/attachments` | `If-Match: {revision}` 필수 |
| 사진 삭제 | `DELETE /api/notes/{noteId}/attachments/{attachmentId}` | `If-Match: {revision}` 필수 |

생성·수정 JSON은 `body`, `color`, `pinned`, `status`, `memberId`, `groupId`, `remindAt`, `reminderState`를 사용합니다. 제목은 `body`의 첫 번째 내용 줄에서 서버가 자동 생성합니다. `createdAt`은 유지되고 변경 때마다 `updatedAt`과 `revision`이 증가합니다.

사진은 `multipart/form-data`의 `photo` 필드로 전송합니다. 응답의 사진 `url`을 불러올 때도 메모 토큰을 Authorization 헤더에 넣어야 합니다. URL 쿼리에 토큰을 넣지 않습니다.

## 3. 증분 동기화

```http
GET /api/mobile/notes/sync?cursor=0&limit=200
```

응답의 `changes`, `nextCursor`, `hasMore`, `serverTime`을 사용합니다.

- `type: "upsert"`: Room의 메모와 첨부파일 배열을 서버 값으로 교체합니다.
- `type: "delete"`: Room 메모와 로컬 사진 캐시를 제거합니다.
- `hasMore: true`: 같은 작업에서 `nextCursor`로 계속 요청합니다.
- 모든 변경을 Room 트랜잭션으로 저장한 뒤 마지막 `nextCursor`를 저장합니다.
- `409 NOTE_VERSION_CONFLICT`: 응답의 최신 `note`를 보여주고 사용자가 다시 적용할지 선택하게 합니다.
- `401 MOBILE_MEMO_TOKEN_EXPIRED`: 메모 세션을 한 번 갱신하고 요청을 재시도합니다.

화면 진입·당겨서 새로고침·FCM 수신 직후 동기화하고, 백그라운드 재시도는 WorkManager를 사용합니다. 짧은 고정 주기 polling은 앱이 화면에 보일 때만 사용합니다.

## 4. 교인 연결 검색

```http
GET /api/mobile/members?query={이름·셀·그룹}&limit=50
```

응답은 `id`, `name`, `cellId`, `cellName`, `groups`, `photoUrl`만 제공합니다. 주소·전화번호·개인 관리 메모는 이 API에서 내려오지 않습니다. 선택한 `id`를 메모의 `memberId`로 저장합니다.

## 5. 알림에서 메모 열기

메모 알림은 제목·본문을 FCM에 넣지 않고 `notificationId`와 `noteId`만 전달합니다. 기존 schema v2와 `reminders/{notificationId}` 경로는 구버전 앱 호환을 위해 유지됩니다.

새 앱은 다음 순서로 처리합니다.

1. `notificationId`로 수신·표시·열기 ACK를 보냅니다.
2. `noteId`가 있으면 메모 세션을 확보합니다.
3. `GET /api/notes/{noteId}`로 최신 내용을 읽습니다.
4. 삭제돼 404이면 알림을 닫고 전체 증분 동기화를 실행합니다.

## 6. Android 구현 구성

- 기존 하단 `알림함` 탭의 이름을 `메모함`으로 변경하고 네이티브 목록·검색·편집 화면을 연결합니다.
- Retrofit/OkHttp: API 호출, 메모 토큰 자동 첨부, 만료 시 한 번만 세션 갱신.
- Android Keystore: 기존 `deviceCredential` 보호. 짧은 메모 토큰은 메모리 우선 저장.
- Room: `notes`, `note_attachments`, `sync_cursor`, 보류 중 변경을 저장.
- WorkManager: 오프라인 변경 재시도와 증분 동기화.
- Coil 또는 동등 이미지 로더: 사진 요청에 Authorization 헤더 추가.
- FirebaseMessagingService: `noteId` 딥 링크, ACK, 즉시 동기화.

첫 버전은 목록·검색·작성·수정·삭제·색상·교인 연결·알림·사진을 한 번에 지원해야 웹과 앱의 기능 차이로 인한 데이터 덮어쓰기를 피할 수 있습니다.

## 7. 서버 배포 순서

1. Pages D1 `0020_mobile_memo_sync.sql` 적용
2. Relay D1 `0003_memo_note_id.sql` 적용
3. 갱신된 Relay Worker 배포
4. 갱신된 알림 Worker를 바로 이어서 배포
5. Relay D1 `0004_memo_note_id_guards.sql` 적용
6. 갱신된 Pages 배포
7. Android 앱 배포

스키마보다 코드를 먼저 배포하면 새 컬럼 조회가 실패할 수 있으므로 이 순서를 지켜야 합니다.
