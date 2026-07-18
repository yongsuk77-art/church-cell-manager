(() => {
  const state = {
    deferredInstallPrompt: null,
    registrationPromise: null,
    installed: isStandalone()
  };

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    notify("pastoral:pwa-installable");
  });

  window.addEventListener("appinstalled", () => {
    state.deferredInstallPrompt = null;
    state.installed = true;
    notify("pastoral:pwa-installed");
  });

  window.PastoralPwa = Object.freeze({
    supportsServiceWorker: () => "serviceWorker" in navigator,
    supportsPush: () => "serviceWorker" in navigator
      && "PushManager" in window
      && "Notification" in window,
    isStandalone,
    isIos,
    platform: detectPlatform,
    canPromptInstall: () => Boolean(state.deferredInstallPrompt),
    registerServiceWorker,
    getSubscription,
    subscribe,
    unsubscribe,
    install
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }

  function initialize() {
    if (!window.PastoralPwa.supportsServiceWorker()) return;
    registerServiceWorker().then(() => notify("pastoral:pwa-ready")).catch(() => {
      notify("pastoral:pwa-error");
    });
  }

  function registerServiceWorker() {
    if (!window.PastoralPwa.supportsServiceWorker()) {
      return Promise.reject(new Error("SERVICE_WORKER_UNSUPPORTED"));
    }
    if (!state.registrationPromise) {
      state.registrationPromise = navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none"
      }).then(() => navigator.serviceWorker.ready).catch((error) => {
        state.registrationPromise = null;
        throw error;
      });
    }
    return state.registrationPromise;
  }

  async function getSubscription() {
    if (!window.PastoralPwa.supportsPush()) return null;
    const registration = await registerServiceWorker();
    return registration.pushManager.getSubscription();
  }

  async function subscribe(publicKey) {
    if (!window.PastoralPwa.supportsPush()) throw new Error("PUSH_UNSUPPORTED");
    const applicationServerKey = base64UrlToBytes(publicKey);
    const registration = await registerServiceWorker();
    let current = await registration.pushManager.getSubscription();
    if (current && !sameApplicationServerKey(current.options?.applicationServerKey, applicationServerKey)) {
      await current.unsubscribe();
      current = null;
    }
    if (Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("NOTIFICATION_PERMISSION_DENIED");
    }
    return current || registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
  }

  async function unsubscribe(subscription) {
    const current = subscription || await getSubscription();
    return current ? current.unsubscribe() : false;
  }

  async function install() {
    if (isStandalone()) return { status: "installed" };
    if (!state.deferredInstallPrompt) {
      return { status: isIos() ? "manual-ios" : "manual" };
    }
    const prompt = state.deferredInstallPrompt;
    state.deferredInstallPrompt = null;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    return { status: choice?.outcome === "accepted" ? "accepted" : "dismissed" };
  }

  function base64UrlToBytes(value) {
    const text = String(value || "");
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("VAPID_PUBLIC_KEY_INVALID");
    const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("VAPID_PUBLIC_KEY_INVALID");
    return bytes;
  }

  function sameApplicationServerKey(existing, expected) {
    if (!existing) return true;
    const bytes = new Uint8Array(existing);
    return bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
  }

  function detectPlatform() {
    const value = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
    if (/iphone|ipad|ipod/.test(value)) return "ios";
    if (/android/.test(value)) return "android";
    if (/win/.test(value)) return "windows";
    if (/mac/.test(value)) return "macos";
    if (/linux/.test(value)) return "linux";
    return "other";
  }

  function isIos() {
    return detectPlatform() === "ios";
  }

  function isStandalone() {
    return window.matchMedia?.("(display-mode: standalone)").matches === true
      || window.navigator.standalone === true;
  }

  function notify(name) {
    window.dispatchEvent(new CustomEvent(name));
  }
})();
