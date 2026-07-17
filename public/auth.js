(function () {
  const panel = document.getElementById("passkeyLoginPanel");
  const button = document.getElementById("passkeyLoginBtn");
  const status = document.getElementById("passkeyLoginStatus");
  const remember = document.getElementById("rememberLogin");

  if (!panel || !button || !status) return;
  if (!window.PublicKeyCredential || !navigator.credentials?.get) return;

  let cachedOptions = null;

  document.addEventListener("DOMContentLoaded", initPasskeyLogin);
  button.addEventListener("click", loginWithPasskey);

  async function initPasskeyLogin() {
    try {
      if (!(await isPlatformAuthenticatorAvailable())) return;
      const options = await fetchLoginOptions();
      if (!options.enabled) return;
      cachedOptions = options;
      panel.classList.remove("hidden");
    } catch {
      panel.classList.add("hidden");
    }
  }

  async function loginWithPasskey() {
    button.disabled = true;
    status.textContent = "기기에 표시되는 창에서 지문 또는 얼굴을 확인해주세요.";
    try {
      if (!(await isPlatformAuthenticatorAvailable())) {
        throw new Error("이 기기에서 지문·얼굴 로그인을 사용할 수 없습니다.");
      }
      const options = cachedOptions?.enabled ? cachedOptions : await fetchLoginOptions();
      if (!options.enabled) throw new Error("등록된 지문·얼굴 로그인이 없습니다.");
      const publicKey = hydrateRequestOptions(options.publicKey);
      const credential = await navigator.credentials.get({ publicKey });
      const response = await fetch("/__auth/passkey/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          token: options.token,
          credential: serializeAssertion(credential),
          remember: Boolean(remember?.checked)
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "지문·얼굴 로그인에 실패했습니다.");
      window.location.href = result.redirect || "/";
    } catch (error) {
      status.textContent = passkeyErrorMessage(error);
      cachedOptions = null;
    } finally {
      button.disabled = false;
    }
  }

  async function isPlatformAuthenticatorAvailable() {
    const check = window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof check !== "function") return true;
    try {
      return await check.call(window.PublicKeyCredential);
    } catch {
      return false;
    }
  }

  function passkeyErrorMessage(error) {
    if (error?.name === "NotAllowedError") {
      return "지문·얼굴 인증이 취소되었거나 제한 시간이 지났습니다.";
    }
    if (error?.name === "SecurityError") {
      return "보안 연결에서만 지문·얼굴 로그인을 사용할 수 있습니다.";
    }
    return error?.message || "지문·얼굴 로그인에 실패했습니다.";
  }

  async function fetchLoginOptions() {
    const response = await fetch("/__auth/passkey/options", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "passkey options failed");
    return result;
  }

  function hydrateRequestOptions(publicKey) {
    return {
      ...publicKey,
      challenge: base64UrlToBuffer(publicKey.challenge),
      allowCredentials: (publicKey.allowCredentials || []).map((credential) => ({
        ...credential,
        id: base64UrlToBuffer(credential.id)
      }))
    };
  }

  function serializeAssertion(credential) {
    return {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || "",
      response: {
        clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
        authenticatorData: bufferToBase64Url(credential.response.authenticatorData),
        signature: bufferToBase64Url(credential.response.signature),
        userHandle: credential.response.userHandle ? bufferToBase64Url(credential.response.userHandle) : ""
      }
    };
  }

  function base64UrlToBuffer(value) {
    const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  function bufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
})();
