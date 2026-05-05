/**
 * Generate a unique ID with browser compatibility fallback.
 * Uses crypto.randomUUID() if available, otherwise falls back to a custom implementation.
 */
function generateFallbackUuid(): string {
  const template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
  return template.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function installRandomUUIDFallback(): void {
  const runtimeCrypto = globalThis.crypto;

  if (runtimeCrypto && typeof runtimeCrypto.randomUUID === "function") {
    return;
  }

  if (runtimeCrypto) {
    Object.defineProperty(runtimeCrypto, "randomUUID", {
      configurable: true,
      writable: true,
      value: () => generateFallbackUuid(),
    });
    return;
  }

  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    writable: true,
    value: {
      randomUUID: () => generateFallbackUuid(),
    } as Crypto,
  });
}

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return generateFallbackUuid();
}
