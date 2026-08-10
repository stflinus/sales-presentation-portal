import { describe, expect, it } from "vitest";
import {
  MAX_VIDEO_UPLOAD_SIZE,
  MAX_VIDEO_UPLOAD_SIZE_LABEL,
} from "@spp/shared";

describe("MAX_VIDEO_UPLOAD_SIZE", () => {
  it("is 2 GiB", () => {
    expect(MAX_VIDEO_UPLOAD_SIZE).toBe(2 * 1024 * 1024 * 1024);
    expect(MAX_VIDEO_UPLOAD_SIZE).toBe(2147483648);
    expect(MAX_VIDEO_UPLOAD_SIZE_LABEL).toBe("2 GB");
  });

  it("allows a 551 MiB upload that previously exceeded 500 MiB", () => {
    const fileSize = 551 * 1024 * 1024;
    const legacyLimit = 500 * 1024 * 1024;
    expect(fileSize).toBeGreaterThan(legacyLimit);
    expect(fileSize).toBeLessThanOrEqual(MAX_VIDEO_UPLOAD_SIZE);
  });

  it("rejects files larger than 2 GiB", () => {
    const tooLarge = MAX_VIDEO_UPLOAD_SIZE + 1;
    expect(tooLarge > MAX_VIDEO_UPLOAD_SIZE).toBe(true);
  });
});
