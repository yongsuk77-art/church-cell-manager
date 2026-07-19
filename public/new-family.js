const form = document.getElementById("newcomerForm");
const message = document.getElementById("message");
const submitButton = document.getElementById("submitBtn");
const token = new URLSearchParams(window.location.search).get("invite") || "";

document.addEventListener("DOMContentLoaded", init);
form.addEventListener("submit", submitRegistration);

async function init() {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    showMessage("등록 주소가 올바르지 않습니다. 안내받은 QR을 다시 확인해주세요.", "error");
    return;
  }
  try {
    const invite = await request(`/api/public/newcomer/${encodeURIComponent(token)}`);
    document.getElementById("pageTitle").textContent = invite.label || "새가족 등록";
    document.getElementById("expiryText").textContent = `등록 가능 기간: ${formatDate(invite.expiresAt)}까지`;
    message.classList.add("hidden");
    form.classList.remove("hidden");
  } catch (error) {
    showMessage(error.message || "등록 링크를 사용할 수 없습니다.", "error");
  }
}

async function submitRegistration(event) {
  event.preventDefault();
  submitButton.disabled = true;
  try {
    await request(`/api/public/newcomer/${encodeURIComponent(token)}`, {
      method: "POST",
      body: {
        name: document.getElementById("name").value.trim(),
        phone: document.getElementById("phone").value.trim(),
        birth: document.getElementById("birth").value,
        address: document.getElementById("address").value.trim(),
        familyDetails: document.getElementById("familyDetails").value.trim(),
        consent: document.getElementById("consent").checked
      }
    });
    form.classList.add("hidden");
    showMessage("등록 신청이 접수되었습니다. 공동체 담당자가 확인한 뒤 안내드리겠습니다.", "success");
  } catch (error) {
    showMessage(error.message || "등록 신청을 접수하지 못했습니다.", "error", false);
  } finally {
    submitButton.disabled = false;
  }
}

async function request(url, options = {}) {
  const headers = new Headers({ Accept: "application/json" });
  let body = options.body;
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  const response = await fetch(url, { ...options, headers, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "요청을 처리하지 못했습니다.");
  return payload;
}

function showMessage(text, kind, hideForm = true) {
  message.textContent = text;
  message.className = `message ${kind || ""}`;
  if (hideForm) form.classList.add("hidden");
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "long" }).format(date)
    : "";
}
