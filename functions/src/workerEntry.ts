/**
 * Cloud Run Job entrypoint for video processing.
 * Env: VIDEO_ID, PROCESSING_GENERATION, PROCESSING_JOB_ID, PROCESSING_ATTEMPT
 */
import { processVideoDocument } from "./callables/processVideo";
import * as logger from "firebase-functions/logger";

async function main(): Promise<void> {
  const videoId = String(process.env.VIDEO_ID || "").trim();
  if (!videoId) {
    throw new Error("VIDEO_ID env required");
  }
  const expectedGeneration = process.env.PROCESSING_GENERATION
    ? Number(process.env.PROCESSING_GENERATION)
    : undefined;
  const jobId = process.env.PROCESSING_JOB_ID || null;

  logger.info("video_worker_start", {
    videoId,
    expectedGeneration,
    jobId,
    attempt: process.env.PROCESSING_ATTEMPT || null,
  });

  await processVideoDocument(videoId, {
    expectedGeneration: Number.isFinite(expectedGeneration)
      ? expectedGeneration
      : undefined,
    jobId,
  });

  logger.info("video_worker_complete", { videoId, jobId });
}

main().catch((err) => {
  console.error("video_worker_fatal", err);
  process.exitCode = 1;
});
