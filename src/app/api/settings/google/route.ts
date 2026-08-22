import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/http";
import { availableGoogleVideoModels } from "@/server/providers/video/google";
import { getProviderKey, providerStatus, saveProviderKey, updateProviderStatus } from "@/server/provider-secrets";
import { assertRateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";

const Body = z.object({ apiKey: z.string().min(20).max(512) });

export async function GET() {
  return NextResponse.json(await providerStatus("google"));
}

export async function POST(request: Request) {
  try {
    assertRateLimit(request, "provider settings", 10, 60_000);
    const { apiKey } = Body.parse(await request.json());
    const models = await availableGoogleVideoModels(apiKey);
    await saveProviderKey("google", apiKey);
    await updateProviderStatus("google", "connected", { availableModelIds: models.filter((model) => model.available).map((model) => model.id) });
    return NextResponse.json({ connected: true, models, key: "saved" });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function PUT() {
  try {
    const apiKey = await getProviderKey("google");
    if (!apiKey) return NextResponse.json({ error: "Google API key is not configured." }, { status: 400 });
    const models = await availableGoogleVideoModels(apiKey);
    await updateProviderStatus("google", "connected", { availableModelIds: models.filter((model) => model.available).map((model) => model.id) });
    return NextResponse.json({ connected: true, models });
  } catch (error) {
    try { await updateProviderStatus("google", "failed", { error: error instanceof Error ? error.message : String(error) }); } catch {}
    return apiError(error, 400);
  }
}
