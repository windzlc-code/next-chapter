import { afterEach, describe, expect, it, vi } from "vitest";
import { generateId, installRandomUUIDFallback } from "./generate-id";

const originalCrypto = globalThis.crypto;

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    writable: true,
    value: originalCrypto,
  });
  vi.restoreAllMocks();
});

describe("generate-id", () => {
  it("uses native randomUUID when available", () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      writable: true,
      value: {
        randomUUID: vi.fn(() => "native-uuid"),
      } as Partial<Crypto>,
    });

    expect(generateId()).toBe("native-uuid");
  });

  it("installs a fallback randomUUID when missing", () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      writable: true,
      value: {} as Partial<Crypto>,
    });

    installRandomUUIDFallback();

    expect(typeof globalThis.crypto.randomUUID).toBe("function");
    expect(globalThis.crypto.randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
