import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/http";
import { providerStatus, saveProviderKey, updateProviderStatus } from "@/server/provider-secrets";
import { testOpenAIConnection } from "@/server/providers/openai";
import { assertRateLimit } from "@/server/rate-limit";
import { env } from "@/server/env";
import { query } from "@/server/db";
import { OPENAI_AVAILABLE_MODELS } from "@/server/providers/openai";

export const runtime = "nodejs";

const Body = z.object({ apiKey: z.string().min(20).max(512) });
const RoutingBody = z.object({ task: z.enum(["screenwriting", "prompts", "qc"]), modelId: z.enum(OPENAI_AVAILABLE_MODELS.map((model) => model.id) as [string, ...string[]]) });

export async function GET() {
  return NextResponse.json(await providerStatus("openai"));
}

export async function POST(request: Request) {
  try {
    assertRateLimit(request, "provider settings", 10, 60_000);
    const { apiKey } = Body.parse(await request.json());
    await saveProviderKey("openai", apiKey);
    const result = await testOpenAIConnection();
    await updateProviderStatus("openai", "connected", result);
    return NextResponse.json({ ...result, key: "saved" });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function PUT() {
  try {
    const result = await testOpenAIConnection();
    try { await updateProviderStatus("openai", "connected", result); } catch {}
    return NextResponse.json(result);
  } catch (error) {
    try { await updateProviderStatus("openai", "failed", { error: error instanceof Error ? error.message : String(error) }); } catch {}
    return apiError(error, 400);
  }
}

export async function PATCH(request: Request) {
  try {
    assertRateLimit(request, "model routing", 30, 60_000);
    const { task, modelId } = RoutingBody.parse(await request.json());
    await query(
      `INSERT INTO workspace_settings (workspace_id,settings) VALUES ($1,jsonb_build_object('openaiModels',jsonb_build_object($2,$3)))
       ON CONFLICT (workspace_id) DO UPDATE SET settings=jsonb_set(workspace_settings.settings,ARRAY['openaiModels',$2],to_jsonb($3::text),true),updated_at=now()`,
      [env().DEFAULT_WORKSPACE_ID, task, modelId],
    );
    return NextResponse.json({ saved: true, task, modelId });
  } catch (error) { return apiError(error, 400); }
}
