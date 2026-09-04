import { GoogleAuth } from "google-auth-library";
import * as logger from "firebase-functions/logger";

const PROJECT_ID =
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  "sales-presentation-portal";
const LOCATION = process.env.VIDEO_PROCESS_JOB_LOCATION || "us-central1";
const JOB_NAME = process.env.VIDEO_PROCESS_JOB_NAME || "spp-video-process";

/**
 * Dispatch a Cloud Run Job execution for long-running FFmpeg work.
 * Cloud Functions (540s) cannot reliably transcode 20+ minute 1080p VP9 sources.
 */
export async function dispatchVideoProcessJob(input: {
  videoId: string;
  generation: number;
  jobId: string;
  attempt: number;
}): Promise<{ executionName: string }> {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const url = `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${LOCATION}/jobs/${JOB_NAME}:run`;

  const res = await client.request<{ name?: string }>({
    url,
    method: "POST",
    data: {
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: "VIDEO_ID", value: input.videoId },
              { name: "PROCESSING_GENERATION", value: String(input.generation) },
              { name: "PROCESSING_JOB_ID", value: input.jobId },
              { name: "PROCESSING_ATTEMPT", value: String(input.attempt) },
              { name: "FFMPEG_PATH", value: "/usr/bin/ffmpeg" },
              { name: "FFPROBE_PATH", value: "/usr/bin/ffprobe" },
            ],
          },
        ],
      },
    },
  });

  const executionName = String(res.data?.name || "");
  logger.info("video_process_job_dispatched", {
    videoId: input.videoId,
    jobId: input.jobId,
    generation: input.generation,
    attempt: input.attempt,
    executionName,
  });
  return { executionName };
}

export function videoProcessJobResource(): string {
  return `projects/${PROJECT_ID}/locations/${LOCATION}/jobs/${JOB_NAME}`;
}
