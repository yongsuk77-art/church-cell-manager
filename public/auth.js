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
    status.textContent = "\uC0DD\uCCB4 \uC778\uC99D\uC744 \uC900\uBE44\uD558\uB294 \uC911\uC785\uB2C8\uB2E4.";
    try {
      const options = cachedOptions?.enabled ? cachedOptions : await fetchLoginOptions();
      if (!options.enabled) throw new Error("\uB4F1\uB85D\uB41C \uD328\uC2A4\uD0A4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
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
      if (!response.ok) throw new Error(result.error || "\uD328\uC2A4\uD0A4 \uB85C\uADF8\uC778\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
      window.location.href = result.redirect || "/";
    } catch (error) {
      status.textContent = error.message || "\uD328\uC2A4\uD0A4 \uB85C\uADF8\uC778\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.";
      cachedOptions = null;
    } finally {
      button.disabled = false;
    }
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
