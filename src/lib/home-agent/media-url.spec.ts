import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  doesUsableMediaAssetExist,
  isMediaAssetDefinitelyMissing,
  resolveLocalMediaPreviewDataUrl,
} from "./media-url";

describe("media-url local asset probing", () => {
  beforeEach(() => {
    window.electronAPI = {
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/CurrentFiles", db: "D:/CurrentDb" })),
        readBase64: vi.fn(async (filePath: string) => {
          const normalized = filePath.replace(/\//g, "\\");
          if (normalized.includes("hero-original.jpg")) {
            return {
              ok: true,
              exists: true,
              base64: "IMAGE_BASE64",
              mimeType: "image/jpeg",
            };
          }
          if (normalized.includes("hero-unknown.jpg")) {
            return {
              ok: false,
              exists: false,
              base64: "",
            };
          }
          return {
            ok: true,
            exists: false,
            base64: "",
          };
        }),
      },
    } as unknown as typeof window.electronAPI;
  });

  it("keeps local media valid when the original path still exists but the remapped path does not", async () => {
    const url = "D:/OldFiles/projects/video-project-1/images/generated/hero-original.jpg";

    await expect(doesUsableMediaAssetExist(url)).resolves.toBe(true);
    await expect(isMediaAssetDefinitelyMissing(url)).resolves.toBe(false);
    await expect(resolveLocalMediaPreviewDataUrl(url)).resolves.toBe("data:image/jpeg;base64,IMAGE_BASE64");
  });

  it("does not mark local media as definitely missing when file probing returns an unknown error", async () => {
    const url = "D:/OldFiles/projects/video-project-1/images/generated/hero-unknown.jpg";

    await expect(doesUsableMediaAssetExist(url)).resolves.toBe(true);
    await expect(isMediaAssetDefinitelyMissing(url)).resolves.toBe(false);
  });
});
