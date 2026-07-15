(() => {
  "use strict";

  const panel = document.getElementById("passkeyLoginPanel");
  const divider = document.getElementById("passkeyDivider");
  const button = document.getElementById("passkeyLoginBtn");
  const status = document.getElementById("passkeyLoginStatus");
  const remember = document.getElementById("rememberLogin");
  const AUTO_PROMPT_KEY = "seosanch-cell:passkey-auto-prompted:v1";
  const AUTO_PROMPT_COOLDOWN_MS = 30 * 1000;
  let loginPending = false;

  if (!panel || !divider || !button || !status || !supportsWebAuthn()) return;

  panel.classList.remove("hidden");
  divider.classList.remove("hidden");
  button.addEventListener("click", () => loginWithPasskey());
  void maybeStartMobilePasskeyLogin();

  async function loginWithPasskey({ automatic = false } = {}) {
    if (loginPending) return;
    loginPending = true;
    button.disabled = true;
    setStatus(automatic
      ? "생체 인증을 여는 중입니다. 휴대폰의 안내를 확인해주세요."
      : "기기 잠금 인증을 준비하는 중입니다.");

    try {
      const optionsResponse = await fetch("/__auth/passkey/options", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store"
      });
      const ceremony = await readJsonResponse(optionsResponse, "패스키 로그인 정보를 불러오지 못했습니다.");
      const credential = await navigator.credentials.get({
        publicKey: decodeAuthenticationOptions(ceremony.options)
      });
      if (!credential) throw new Error("패스키 인증이 취소되었습니다.");

      setStatus("패스키를 확인하는 중입니다.");
      const loginResponse = await fetch("/__auth/passkey/login", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          challengeToken: ceremony.challengeToken,
          credential: serializeAuthenticationCredential(credential),
          remember: Boolean(remember?.checked)
        })
      });
      await readJsonResponse(loginResponse, "패스키 로그인을 완료하지 못했습니다.");
      setStatus("로그인되었습니다.");
      window.location.replace("/");
    } catch (error) {
      if (automatic && (error?.name === "NotAllowedError" || error?.name === "AbortError")) {
        setStatus("생체 인증을 건너뛰었습니다. 버튼을 누르거나 비밀번호로 로그인할 수 있습니다.");
      } else {
        setStatus(passkeyErrorMessage(error), true);
      }
      button.disabled = false;
    } finally {
      loginPending = false;
    }
  }

  async function maybeStartMobilePasskeyLogin() {
    if (document.body?.dataset.passkeyAutostart !== "true" || !isMobileDevice()) return;
    if (document.visibilityState !== "visible" || wasAutoPrompted()) return;
    const availabilityCheck = window.PublicKeyCredential
      ?.isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof availabilityCheck !== "function") return;

    try {
      if (!(await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return;
      markAutoPrompted();
      await loginWithPasskey({ automatic: true });
    } catch {
      // Some mobile browsers require a user gesture. The visible button remains available.
    }
  }

  function isMobileDevice() {
    if (navigator.userAgentData?.mobile === true) return true;
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")) return true;
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  }

  function wasAutoPrompted() {
    try {
      const lastPromptedAt = Number(sessionStorage.getItem(AUTO_PROMPT_KEY) || 0);
      return Number.isFinite(lastPromptedAt)
        && lastPromptedAt > 0
        && Date.now() - lastPromptedAt < AUTO_PROMPT_COOLDOWN_MS;
    } catch {
      return false;
    }
  }

  function markAutoPrompted() {
    try {
      sessionStorage.setItem(AUTO_PROMPT_KEY, String(Date.now()));
    } catch {
      // Storage can be unavailable in private browsing; the current page still prompts once.
    }
  }

  function supportsWebAuthn() {
    return Boolean(
      window.isSecureContext
      && window.PublicKeyCredential
      && navigator.credentials
      && typeof navigator.credentials.get === "function"
    );
  }

  function decodeAuthenticationOptions(options) {
    if (!options || typeof options !== "object") throw new Error("패스키 로그인 정보가 올바르지 않습니다.");
    return {
      ...options,
      challenge: base64UrlToBytes(options.challenge),
      allowCredentials: Array.isArray(options.allowCredentials)
        ? options.allowCredentials.map((credential) => ({
          ...credential,
          id: base64UrlToBytes(credential.id)
        }))
        : []
    };
  }

  function serializeAuthenticationCredential(credential) {
    const response = credential.response;
    return {
      id: credential.id,
      rawId: bytesToBase64Url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults?.() || {},
      response: {
        clientDataJSON: bytesToBase64Url(response.clientDataJSON),
        authenticatorData: bytesToBase64Url(response.authenticatorData),
        signature: bytesToBase64Url(response.signature),
        userHandle: response.userHandle ? bytesToBase64Url(response.userHandle) : undefined
      }
    };
  }

  async function readJsonResponse(response, fallbackMessage) {
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || fallbackMessage);
      error.code = result.code || "";
      throw error;
    }
    return result;
  }

  function base64UrlToBytes(value) {
    const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function bytesToBase64Url(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function passkeyErrorMessage(error) {
    if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
      return "인증이 취소되었거나 시간이 초과되었습니다. 다시 시도해주세요.";
    }
    if (error?.name === "SecurityError") {
      return "현재 주소에서는 패스키를 사용할 수 없습니다. 공식 운영 주소인지 확인해주세요.";
    }
    if (error?.code === "CHALLENGE_REPLAYED" || error?.code === "CHALLENGE_INVALID") {
      return "로그인 요청이 만료되었습니다. 버튼을 눌러 다시 시도해주세요.";
    }
    return error?.message || "패스키 로그인을 완료하지 못했습니다. 비밀번호로 로그인해주세요.";
  }

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("error-text", isError);
  }
})();
