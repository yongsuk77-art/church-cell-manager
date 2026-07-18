const APP_NAME = "목양웹";
const APP_ICON = "/favicon.png";
const APP_BADGE = "/pwa-icon-192.png";
const ALLOWED_PATHS = new Set(["/", "/index.html", "/memos.html"]);

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const payload = readPayload(event.data);
  event.waitUntil(self.registration.showNotification(APP_NAME, {
    body: notificationBody(payload.kind),
    icon: APP_ICON,
    badge: APP_BADGE,
    tag: safeTag(payload.tag),
    data: { url: safeRelativeUrl(payload.data?.url), notificationId: safeId(payload.data?.notificationId) },
    lang: "ko-KR",
    renotify: false,
    requireInteraction: false
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(safeRelativeUrl(event.notification.data?.url), self.location.origin).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ("navigate" in client) await client.navigate(targetUrl);
      return client.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});

function readPayload(data) {
  if (!data) return {};
  try {
    const value = data.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function notificationBody(kind) {
  if (kind === "memo_reminder") return "예약한 메모 알림이 도착했습니다.";
  if (kind === "visit_alarm") return "심방 일정 알림이 도착했습니다.";
  if (kind === "today_pastoral") return "오늘 확인할 목양 항목이 있습니다.";
  if (kind === "connection_test") return "이 기기에서 목양웹 알림을 받을 수 있습니다.";
  return "목양웹에 확인할 알림이 있습니다.";
}

function safeRelativeUrl(value) {
  try {
    const url = new URL(String(value || "/"), self.location.origin);
    if (url.origin !== self.location.origin || !ALLOWED_PATHS.has(url.pathname)) return "/";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

function safeTag(value) {
  const tag = String(value || "pastoral-notification");
  return /^[A-Za-z0-9:_-]{1,160}$/.test(tag) ? tag : "pastoral-notification";
}

function safeId(value) {
  const id = String(value || "");
  return /^[0-9a-f-]{36}$/i.test(id) ? id : "";
}
