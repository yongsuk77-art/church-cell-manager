# 심방콜노트 중앙 FCM Relay 운영 런북

## 1. 역할과 신뢰 경계

중앙 Relay만 `FCM_SERVICE_ACCOUNT_JSON`과 `FCM_TARGET_PROJECT_ID`를 보유한다. 각 공동체 관리 웹(clone)은 자기 D1에서 예약 시각과 ACK를 관리하고, site별 HMAC 인증을 거쳐 Relay에 발송을 요청한다.

```text
clone Worker -- site HMAC/HTTPS --> central Relay -- FCM --> Android
Android     -- device credential -----------------------> 원 clone ACK API
```

Relay는 Android ACK를 받거나 저장하지 않는다. Relay의 성공은 FCM이 메시지를 받아들였다는 뜻이고, 실제 수신·표시·열람 상태는 원 clone D1이 관리한다.

## 2. 필수 바인딩과 secret

Relay Worker에는 다음 값이 필요하다.

| 이름 | 종류 | 설명 |
|---|---|---|
| `DB` | D1 binding | `relay-migrations`의 모든 migration을 순서대로 적용한 중앙 DB |
| `RELAY_ADMIN_TOKEN` | secret | 최소 32바이트 관리자 bearer token |
| `RELAY_MASTER_SECRET` | secret | 최소 32바이트. site HMAC key와 FCM target을 AES-GCM으로 암호화 |
| `FCM_SERVICE_ACCOUNT_JSON` | secret | 중앙 Relay에만 저장하는 Firebase 서비스 계정 JSON |
| `FCM_TARGET_PROJECT_ID` | var | Android 앱이 등록된 대상 Firebase project ID |
| `RELAY_SEND_ENABLED` | var | 정확히 `true`일 때만 실제 FCM 발송 |

서비스 계정 JSON의 `project_id`와 FCM 대상 프로젝트는 다를 수 있으므로 endpoint는 항상 `FCM_TARGET_PROJECT_ID`를 사용한다. 서비스 계정에는 대상 프로젝트의 FCM 메시지 생성에 필요한 최소 권한만 부여한다.

선택 설정과 기본값은 다음과 같다.

| 이름 | 기본값 | 허용 범위 |
|---|---:|---:|
| `RELAY_REQUEST_RATE_LIMIT_PER_MINUTE` | 90 | 1–90 |
| `RELAY_SITE_RATE_LIMIT_PER_MINUTE` | 60 | 1–600 |
| `RELAY_TARGET_RATE_LIMIT_PER_MINUTE` | 30 | 1–600 |
| `RELAY_DELIVERY_MAX_ROWS_PER_SITE` | 10,000 | 1–10,000 |
| `RELAY_DELIVERY_RETENTION_DAYS` | 180일 | 7–365일 |
| `RELAY_TARGET_MAX_ROWS_PER_SITE` | 100 | 1–100 |
| `RELAY_TARGET_RETENTION_DAYS` | 180일 | 7–365일 |
| `RELAY_UPSTREAM_TIMEOUT_MS` | 12,000ms | 1–12,000ms |

D1 trigger는 site당 delivery 10,000개, target 100개, 살아 있는 replay nonce 1,000개를 하드 상한으로 강제한다. 환경변수로는 그보다 낮은 runtime 한도만 지정할 수 있다.

## 3. 최초 배포

1. 중앙 Relay용 D1을 만들고 `relay-migrations`의 pending migration을 번호 순서대로 remote DB에 모두 적용한다. 기존에 `0001`을 적용한 DB도 `0002`를 반드시 추가 적용한다.
2. Relay Worker 설정에서 `DB`를 그 D1에 연결한다.
3. `RELAY_ADMIN_TOKEN`, `RELAY_MASTER_SECRET`, `FCM_SERVICE_ACCOUNT_JSON`을 `wrangler secret put`으로 등록한다. 평문을 저장소나 `vars`에 넣지 않는다.
4. `FCM_TARGET_PROJECT_ID`를 Android의 Firebase project로 지정한다.
5. 최초에는 `RELAY_SEND_ENABLED=false`로 배포한다.
6. 아래 관리자 API로 site를 등록하고 clone에 반환된 `keyId`와 `secret`을 각각 `RELAY_KEY_ID`, `RELAY_HMAC_SECRET`으로 설치한다.
7. target PUT과 연결 시험을 수행한다.
8. 한 site에서 메모 알림과 심방내역 알람을 시험한 뒤에만 `RELAY_SEND_ENABLED=true`로 전환한다.

## 4. 관리자 API

모든 관리자 요청은 다음 header가 필요하다.

```text
Authorization: Bearer {RELAY_ADMIN_TOKEN}
Content-Type: application/json
```

인증은 body를 읽기 전에 검사한다. 실패 응답은 항상 `{"code":"..."}` 형태다.

### Site 등록 및 최초 key 발급

```http
POST /admin/v1/sites
```

정확한 body:

```json
{
  "siteId": "11111111-1111-4111-8111-111111111111",
  "siteOrigin": "https://community.example.com"
}
```

`siteId`는 lowercase canonical non-nil UUID여야 한다. `siteOrigin`은 HTTPS origin만 허용하며 사용자 정보, 비기본 port, path, query, fragment를 허용하지 않는다.

성공은 HTTP 201이다.

```json
{
  "code": "SITE_CREATED",
  "siteId": "11111111-1111-4111-8111-111111111111",
  "siteOrigin": "https://community.example.com",
  "keyId": "rkey_v1_...22 base64url chars...",
  "secret": "...43 base64url chars..."
}
```

`secret`은 이 응답에서 한 번만 평문으로 제공된다. Relay D1에는 `RELAY_MASTER_SECRET`에서 목적 분리해 파생한 AES-GCM key로 암호화하여 저장한다.

### Site key 회전

```http
POST /admin/v1/sites/{siteId}/keys/rotate
Content-Type: application/json

{}
```

성공은 HTTP 200이다.

```json
{
  "code": "SITE_KEY_ROTATED",
  "siteId": "...",
  "keyId": "rkey_v1_...",
  "secret": "...",
  "previousValidUntil": "2026-07-15T12:00:00.000Z"
}
```

새 key는 즉시 `current`가 되고 이전 key는 24시간 동안 verify-only `previous`가 된다. 그보다 오래된 previous key는 즉시 revoke된다.

안전한 회전 순서:

1. rotate API로 새 key를 만든다.
2. 해당 clone의 `RELAY_KEY_ID`와 `RELAY_HMAC_SECRET`을 새 값으로 바꾼다.
3. target PUT 또는 연결 시험이 새 key로 성공하는지 확인한다.
4. 24시간 grace가 끝난 뒤 이전 key가 거부되는지 확인한다.

## 5. Clone → Relay HMAC V1

요청 header:

```text
X-Callsum-Site-Id
X-Callsum-Key-Id
X-Callsum-Timestamp
X-Callsum-Nonce
X-Callsum-Signature: v1={base64url HMAC-SHA256}
```

서명 원문은 아래 줄을 정확히 LF(`\n`)로 연결한다.

```text
CALLSUM-RELAY-HMAC-V1
{UPPERCASE METHOD}
{URL pathname}
{siteId}
{keyId}
{Unix seconds}
{128-bit base64url nonce}
{base64url SHA-256 of exact raw body bytes}
```

- 허용 시계 차이는 ±5분이다.
- nonce는 정확히 16 random bytes이며 base64url 22글자다.
- Relay는 서명이 맞은 뒤 D1의 `(siteId,keyId,nonceHash)` unique key에 nonce를 기록한다.
- 유효한 HMAC 요청은 nonce를 기록하기 전에 site 전체 분당 admission 제한을 통과해야 한다. 이 제한은 target PUT/DELETE와 delivery POST를 모두 합산한다.
- nonce 보존 시간은 10분이다.
- 재시도할 때 nonce는 새로 만들고 delivery의 멱등 식별자는 유지한다.
- 메서드, pathname 또는 raw body 한 바이트라도 달라지면 서명 검증이 실패한다.
- JSON body는 16KiB까지만 streaming 방식으로 읽고, 초과하는 즉시 stream을 취소한다.

## 6. FCM target API

### 등록 또는 갱신

```http
PUT /v1/targets/{siteDeviceId}
```

`siteDeviceId`는 clone D1의 canonical UUID다. body는 정확히 네 필드다.

```json
{
  "targetKind": "fid",
  "targetValue": "raw Firebase installation ID",
  "deviceGeneration": 1,
  "targetRevision": 1
}
```

`targetKind`는 `fid` 또는 `registration_token`만 허용한다. raw FID/token은 이 등록 endpoint에서만 받는다. 정상 delivery에는 절대로 포함하지 않는다.

성공 응답은 정확히 다음 형태다.

```json
{
  "targetHandle": "rth_v1_...32 base64url chars...",
  "status": "active",
  "deviceGeneration": 1,
  "targetRevision": 1
}
```

`targetHandle`의 고정 정규식은 다음과 같다.

```text
^rth_v1_[A-Za-z0-9_-]{32}$
```

동일 `(siteId,siteDeviceId)` 갱신은 같은 handle을 유지하며 generation/revision이 뒤로 가는 요청을 거부한다. 새 `siteDeviceId`로 재페어링할 때 `deviceGeneration`은 그 site의 모든 과거 target보다 커야 한다. 그러지 않으면 이전 기기의 늦은 PUT이 새 기기를 되돌려 놓을 수 있으므로 `TARGET_VERSION_STALE` 또는 `TARGET_GENERATION_CONFLICT`로 거부한다. `relay_sites`의 generation/revision tombstone은 target row가 revoke·정리된 뒤에도 최고 버전을 유지하며, tombstone 갱신과 target 변경은 같은 D1 batch에서 조건부로 처리된다. 정상 재페어링은 기존 active target을 revoke하고 새 opaque handle을 만든다. 새 handle을 만드는 이유는 이전 기기의 지연된 `DELETE`가 새 기기를 revoke하지 못하게 하기 위해서다.

Relay는 site당 active target 한 개와 전체 site에서 active target fingerprint 한 개만 허용한다. 같은 FID/token이 다른 site에 active이면 HTTP 409 `TARGET_ALREADY_ACTIVE`로 거부한다.

### 해제

```http
DELETE /v1/targets/{targetHandle}
```

body는 없어야 한다. 존재하지 않거나 이미 revoke된 handle도 정보 노출 없이 HTTP 204로 멱등 처리한다. 조회와 revoke는 인증된 `siteId`로 항상 범위를 제한한다.

### Target 보관 정책

새 기기로 재페어링할 때마다 새 handle이 필요하므로 revoked row는 즉시 삭제하지 않는다. 기본 180일이 지나고 어떤 delivery도 참조하지 않는 revoked/unregistered target만 정리한다. site당 runtime 상한은 기본 100개이며 D1 trigger도 100개를 하드 상한으로 강제한다.

현재 Android는 Relay가 보낸 pairing challenge를 확인하지 않는다. 따라서 서버는 global active fingerprint unique와 site당 active 1개를 강제하지만, 침해된 clone이 외부에서 알아낸 미등록 FID를 처음 등록하는 행위까지 암호학적으로 증명·차단하지는 못한다. Android가 challenge를 지원하면 pending target → FCM challenge → app confirmation 후 active 전환을 추가해야 한다.

## 7. Delivery API와 개인정보 제한

```http
POST /v1/deliveries
```

Clone → Relay body는 정확히 아홉 필드다.

```json
{
  "schemaVersion": "2",
  "targetHandle": "rth_v1_...",
  "deviceGeneration": 1,
  "targetRevision": 1,
  "notificationId": "33333333-3333-4333-8333-333333333333",
  "type": "memo_reminder",
  "reminderId": "77777777-7777-4777-8777-777777777777",
  "scheduledAt": "2026-07-14T12:00:00.000Z",
  "route": "reminders/33333333-3333-4333-8333-333333333333"
}
```

- `type`: `memo_reminder`, `visit_alarm`, `connection_test`
- `connection_test`의 `reminderId`는 빈 문자열이다.
- 나머지 두 종류의 `reminderId`는 UUID다.
- `route`는 반드시 `reminders/{notificationId}`와 정확히 일치한다.
- target의 현재 generation/revision과 요청의 두 값이 정확히 일치해야 발송한다.
- 알 수 없는 필드가 하나라도 있으면 거부한다.

멱등 단위는 `(siteId,notificationId,deviceGeneration,targetRevision)`이다. payload hash가 같으면 저장된 결과를 반환하고, 같은 단위에서 payload가 다르면 HTTP 409 `IDEMPOTENCY_CONFLICT`다. target version이 바뀌면 같은 notification ID라도 별도 시도로 처리한다.

Relay → FCM data는 정확히 일곱 필드만 포함한다.

```text
schemaVersion
siteId
type
notificationId
reminderId
scheduledAt
route
```

`deviceGeneration`, `targetRevision`, `targetHandle`, FID/token은 Android payload에 들어가지 않는다. 성도 이름·성도 ID·전화번호·주소·사진·메모 제목/본문·심방 내용도 Relay 요청, 저장 row, FCM payload에 포함하지 않는다.

성공 HTTP 응답은 항상 아래 다섯 필드를 가진다.

```json
{
  "outcome": "accepted",
  "httpStatus": 200,
  "errorCode": "",
  "retryAfterMs": 0,
  "messageName": "projects/.../messages/..."
}
```

`outcome` 의미:

| 값 | 처리 |
|---|---|
| `accepted` | FCM이 수락. 같은 target version에서 재전송하지 않음 |
| `unregistered` | target을 사용할 수 없음. clone에서 재등록 필요 |
| `retry` | 네트워크, 408, 429, 5xx. `retryAfterMs` 이후 같은 멱등키·새 nonce로 재시도 |
| `blocked` | 발송 disabled, 자격증명·권한·암호화 상태 등 운영 조치 필요 |
| `dead` | 영구적인 FCM 4xx 등 재시도하지 않음 |

OAuth와 FCM 두 network call은 개별 15초가 아니라 하나의 기본 12초 deadline을 공유한다. clone의 전체 요청 timeout보다 먼저 Relay가 결과를 저장하고 반환하기 위한 제한이다.

## 8. Rate limit, retention, 로그

- 유효한 HMAC을 통과한 모든 clone 요청은 nonce 저장 전에 site별 기본 분당 90회로 제한한다.
- 정상 schema와 HMAC을 통과한 delivery는 그 안에서 site별 기본 분당 60회로 다시 제한한다.
- target PUT은 별도 scope에서 site별 기본 분당 30회로 제한한다.
- replay nonce는 site별 최대 1,000개이며 admission 제한을 초과한 요청은 nonce를 소비하지 않는다.
- 초과 시 HTTP 429 `{"code":"SITE_RATE_LIMITED"}`와 `Retry-After`를 반환한다.
- delivery row는 기본 180일 후 정리한다.
- site당 delivery row는 기본/하드 최대 10,000개다.
- body, FID/token, HMAC secret, Authorization, 암호문, Firebase OAuth token을 로그로 출력하지 않는다.
- 허용되는 운영 지표는 siteId, 결과 분류, HTTP 상태, 지연시간, rate-limit 횟수처럼 내용 없는 메타데이터뿐이다.
- site 생성과 key 회전 성공은 `relay_admin_audit`에 action, siteId, keyId, 결과, 시각만 append한다. 평문 secret은 감사 row에 저장하지 않는다.

## 9. 시험 명령과 필수 확인

중앙 Relay 신규 테스트:

```powershell
node --test tests/fcm-relay.test.mjs
```

전체 저장소 테스트:

```powershell
npm test
```

배포 전 최소 확인:

1. HMAC 본문 변조·timestamp 초과·nonce replay가 거부된다.
2. site A가 site B의 active FID/handle을 등록 또는 발송할 수 없다.
3. 동일 site 새 deviceId에는 새 handle이 발급되고, 이전 handle의 지연 DELETE가 새 target에 영향을 주지 않는다.
4. Clone → Relay는 9필드이고 FCM → Android는 7필드다.
5. generation/revision이 다르면 FCM fetch가 호출되지 않는다.
6. `RELAY_SEND_ENABLED=false`에서 target 등록은 되지만 FCM 발송은 한 번도 호출되지 않는다.
7. target/delivery rate limit과 row cap/retention이 작동한다.
8. 메모 알림, 심방내역 알람, 연결 시험이 각각 Android에서 표시되고 원 clone으로 ACK된다.

## 10. 장애와 회전 대응

- Firebase 404에서 명시적인 `UNREGISTERED` 또는 `INSTALLATION_ID_NOT_REGISTERED`일 때만 target을 unregistered로 바꾼다. 일반 project 404는 구성 문제로 `blocked` 처리한다.
- FCM service account를 교체할 때는 중앙 secret만 바꾸며 clone key와 Android pairing은 건드리지 않는다.
- `RELAY_MASTER_SECRET` 변경은 기존 site key와 target 암호문을 복호화할 수 없게 한다. 단순 secret 교체를 하지 말고 별도 re-encryption migration과 검증·rollback 계획을 먼저 준비한다.
- site key 유출 시 즉시 rotate하고 clone secret을 교체한다. 긴급 차단이 필요하면 하나의 D1 변경 절차에서 해당 `relay_sites.status='revoked'`, `revoked_at`, `updated_at`을 기록하고 `relay_admin_audit`에 `site.revoke` 성공 row를 추가한다. 작업 전후 siteId와 현재 keyId만 기록하며 secret은 출력하지 않는다.
- Relay가 FCM 성공 직후 상태 저장 전에 중단되면 재시도로 중복 전송될 수 있다. 서버 멱등성과 Android의 `(siteId,notificationId)` 중복 제거가 모두 필요하다.
