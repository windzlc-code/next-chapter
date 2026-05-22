import { describe, expect, it } from "vitest";

const {
  dreaminaCliCancelVideo,
  dreaminaCliGenerateVideo,
  dreaminaCliGetStatus,
  dreaminaCliLogin,
  dreaminaCliQueryResult,
  dreaminaCliRelogin,
  getDreaminaCliModelCatalog,
  isDreaminaCliAvailable,
} = await import("./dreamina-cli");

describe("dreamina-cli compatibility shim", () => {
  it("reports the CLI bridge as unavailable", async () => {
    expect(await isDreaminaCliAvailable()).toBe(false);
    await expect(dreaminaCliGetStatus()).resolves.toMatchObject({
      ok: false,
      installed: false,
      loggedIn: false,
    });
  });

  it("returns unsupported responses for login helpers", async () => {
    await expect(dreaminaCliLogin()).resolves.toMatchObject({ ok: false, installed: false });
    await expect(dreaminaCliRelogin()).resolves.toMatchObject({ ok: false, installed: false });
  });

  it("rejects legacy video operations", async () => {
    await expect(dreaminaCliGenerateVideo({ prompt: "test" })).rejects.toThrow(
      "Dreamina CLI bridge has been removed",
    );
    await expect(dreaminaCliQueryResult("task-1")).rejects.toThrow(
      "Dreamina CLI bridge has been removed",
    );
    await expect(dreaminaCliCancelVideo("task-1")).rejects.toThrow(
      "Dreamina CLI bridge has been removed",
    );
  });

  it("exposes an empty legacy model catalog", () => {
    expect(getDreaminaCliModelCatalog()).toEqual([]);
  });
});
