import { NextResponse } from "next/server";
import { providerStatus } from "@/server/provider-secrets";
import { OPENAI_AVAILABLE_MODELS, OPENAI_TASK_MODELS, openAIModelRouting } from "@/server/providers/openai";
import { GOOGLE_VIDEO_MODELS } from "@/domain/video-models";
import { z } from "zod";
import { env } from "@/server/env";
import { query } from "@/server/db";
import { apiError } from "@/server/http";

export const runtime = "nodejs";

export async function GET() {
  const [google, openai] = await Promise.all([providerStatus("google"), providerStatus("openai")]);
  const routing = await openAIModelRouting();
  const rows = await query<{ settings: Record<string, unknown> }>("SELECT settings FROM workspace_settings WHERE workspace_id=$1", [env().DEFAULT_WORKSPACE_ID]).catch(() => []);
  const saved = rows[0]?.settings ?? {};
  return NextResponse.json({
    google: {
      ...google,
      models: Object.values(GOOGLE_VIDEO_MODELS),
      quota: null,
      quotaNote: "The Gemini Models API does not return remaining account quota. Active limits are shown in Google AI Studio.",
    },
    openai: { ...openai, taskModels: OPENAI_TASK_MODELS, availableModels: OPENAI_AVAILABLE_MODELS, routing },
    engine: {
      qcRetryThreshold: saved.qcRetryThreshold ?? env().QC_RETRY_THRESHOLD,
      qcFlagThreshold: saved.qcFlagThreshold ?? env().QC_FLAG_THRESHOLD,
      automaticRetries: saved.automaticRetries ?? env().MAX_AUTO_RETRIES,
      workerConcurrency: saved.workerConcurrency ?? env().WORKER_CONCURRENCY,
    },
    storage: { bucket: env().S3_BUCKET, region: env().S3_REGION, endpoint: env().S3_PUBLIC_ENDPOINT ?? env().S3_ENDPOINT },
  });
}

const EngineBody = z.object({
  qcRetryThreshold: z.number().min(0).max(100),
  qcFlagThreshold: z.number().min(0).max(100),
  automaticRetries: z.number().int().min(0).max(5),
  workerConcurrency: z.number().int().min(1).max(16),
}).refine((value) => value.qcRetryThreshold <= value.qcFlagThreshold, "Retry threshold must not exceed the flag threshold.");

export async function PATCH(request: Request) {
  try {
    const engine = EngineBody.parse(await request.json());
    await query(
      `INSERT INTO workspace_settings (workspace_id,settings) VALUES ($1,$2)
       ON CONFLICT (workspace_id) DO UPDATE SET settings=workspace_settings.settings || EXCLUDED.settings`,
      [env().DEFAULT_WORKSPACE_ID, JSON.stringify(engine)],
    );
    return NextResponse.json({ saved: true, engine });
  } catch (error) {
    return apiError(error, 400);
  }
}
