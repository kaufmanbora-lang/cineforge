import { NextResponse } from "next/server";
import { providerStatus } from "@/server/provider-secrets";
import { OPENAI_AVAILABLE_MODELS, OPENAI_TASK_MODELS, openAIModelRouting } from "@/server/providers/openai";
import { GOOGLE_VIDEO_MODELS } from "@/domain/video-models";

export const runtime = "nodejs";

export async function GET() {
  const [google, openai] = await Promise.all([providerStatus("google"), providerStatus("openai")]);
  const routing = await openAIModelRouting();
  return NextResponse.json({
    google: {
      ...google,
      models: Object.values(GOOGLE_VIDEO_MODELS),
      quota: null,
      quotaNote: "The Gemini Models API does not return remaining account quota. Active limits are shown in Google AI Studio.",
    },
    openai: { ...openai, taskModels: OPENAI_TASK_MODELS, availableModels: OPENAI_AVAILABLE_MODELS, routing },
  });
}
