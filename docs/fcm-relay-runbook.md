# 중앙 FCM Relay 연결 안내

이 저장소는 중앙 Relay 서버를 포함하지 않는 개별 목양웹 사이트입니다. Firebase 서비스 계정과 FCM 발송 권한은 중앙 Relay인 `https://callsum-fcm-relay.holylkh.workers.dev`에만 둡니다.

## 기본 상태

- Pages 프로젝트: `church-cell-manager`
- 사이트 origin: `https://church-cell-manager.pages.dev`
- 알림 Worker: `church-cell-manager-call-note-push`
- 전송 방식: `PUSH_TRANSPORT=relay`
- 중앙 Relay URL: `https://callsum-fcm-relay.holylkh.workers.dev`
- 실제 발송: 중앙 키 연결 전까지 `PUSH_SEND_ENABLED=false`

`siteId`는 `0019_notification_site_identity.sql`을 운영 D1에 적용한 뒤 `app_settings`의 `notification.siteId`에서 확인합니다. 다른 사이트의 ID나 키를 복사하지 않습니다.

## 중앙 운영자에게 전달할 값

1. `siteId`
2. `siteOrigin` (`https://church-cell-manager.pages.dev`)
3. Pages 프로젝트명 (`church-cell-manager`)
4. 알림 Worker명 (`church-cell-manager-call-note-push`)

중앙 운영자가 반환하는 `RELAY_KEY_ID`와 `RELAY_HMAC_SECRET`은 공개하지 않고 Pages와 알림 Worker의 secret으로 설정합니다. 값은 Git, 문서, `.dev.vars`, Wrangler `vars`에 평문으로 저장하지 않습니다.

## 키 수령 후 활성화

```powershell
npx wrangler pages secret put RELAY_KEY_ID --project-name church-cell-manager
npx wrangler pages secret put RELAY_HMAC_SECRET --project-name church-cell-manager
npx wrangler pages secret put NOTIFICATION_SECRET --project-name church-cell-manager
npx wrangler secret put RELAY_KEY_ID --config wrangler.notifications.jsonc
npx wrangler secret put RELAY_HMAC_SECRET --config wrangler.notifications.jsonc
npx wrangler secret put NOTIFICATION_SECRET --config wrangler.notifications.jsonc
```

Pages와 Worker에는 동일한 `NOTIFICATION_SECRET`을 입력합니다. 그 뒤 아래 순서로 확인합니다.

1. `npm run dry-run:notifications`
2. `npm run deploy:notifications`
3. 설정 화면에서 연결코드 생성
4. Android 콜노트 앱에서 페어링 및 알림 권한 허용
5. 테스트 알림 수신과 ACK 확인
6. 정상 확인 후에만 `PUSH_SEND_ENABLED=true`로 변경하고 Worker 재배포

## 개인정보 경계

Relay 요청과 FCM payload에는 성도 이름, 전화번호, 주소, 사진, 메모 제목·본문, 심방 내용이 들어가지 않습니다. `siteId`, opaque target handle, 알림 ID, 종류, 예약 시각, 앱 내부 route만 전달합니다. 실제 상세 내용은 인증된 앱이 원 사이트 API에서 다시 조회합니다.

Android ACK는 중앙 Relay가 아니라 이 사이트의 `/api/integrations/call-note/notifications/{notificationId}/ack`로 전송하며, 최종 수신·표시·열람 상태는 이 사이트 D1에 저장합니다.
