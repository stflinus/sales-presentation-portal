import { describe, expect, it } from "vitest";
import { classifyFfmpegFailure } from "../../functions/src/lib/videoProcessingDiagnostics";

describe("classifyFfmpegFailure cancellation diagnostics", () => {
  it("maps generation-superseded cancel message away from UNKNOWN", () => {
    expect(
      classifyFfmpegFailure(
        "Processing cancelled (generation superseded or cancelled).",
      ),
    ).toBe("GENERATION_SUPERSEDED");
  });

  it("maps generic processing cancelled messages", () => {
    expect(classifyFfmpegFailure("Processing cancelled by operator.")).toBe(
      "PROCESSING_CANCELLED",
    );
  });
});
