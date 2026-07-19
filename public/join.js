const form = document.querySelector("#joinForm");
const churchSelect = document.querySelector("#churchId");
const statusNode = document.querySelector("#joinStatus");
const submitButton = document.querySelector("#joinSubmit");

loadChurches();
form?.addEventListener("submit", submitJoinRequest);

async function loadChurches() {
  try {
    const response = await fetch("/api/public/churches", { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "교회 목록을 불러오지 못했습니다.");
    const churches = Array.isArray(payload.churches) ? payload.churches : [];
    churchSelect.innerHTML = churches.length
      ? `<option value="">가입할 교회를 선택하세요</option>${churches.map((church) => (
        `<option value="${escapeHtml(church.id)}">${escapeHtml(church.name)}</option>`
      )).join("")}`
      : `<option value="">가입 가능한 교회가 없습니다</option>`;
    churchSelect.disabled = churches.length === 0;
    submitButton.disabled = churches.length === 0;
  } catch (error) {
    churchSelect.innerHTML = `<option value="">교회 목록을 불러오지 못했습니다</option>`;
    churchSelect.disabled = true;
    submitButton.disabled = true;
    setStatus(error.message || "교회 목록을 불러오지 못했습니다.");
  }
}

async function submitJoinRequest(event) {
  event.preventDefault();
  const values = new FormData(form);
  const password = String(values.get("password") || "");
  const passwordConfirm = String(values.get("passwordConfirm") || "");
  if (password !== passwordConfirm) {
    setStatus("비밀번호 확인이 일치하지 않습니다.");
    return;
  }
  setBusy(true);
  setStatus("가입 신청을 보내는 중입니다.");
  try {
    const response = await fetch("/api/public/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        churchId: values.get("churchId"),
        displayName: values.get("displayName"),
        username: values.get("username"),
        password
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "가입 신청에 실패했습니다.");
    form.reset();
    setStatus(payload.message || "가입 신청이 접수되었습니다.", true);
  } catch (error) {
    setStatus(error.message || "가입 신청에 실패했습니다.");
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  submitButton.disabled = busy || churchSelect.disabled;
  submitButton.textContent = busy ? "신청 중..." : "가입 신청";
}

function setStatus(message, success = false) {
  statusNode.textContent = String(message || "");
  statusNode.classList.toggle("success", success);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
