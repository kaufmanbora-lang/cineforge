import { NextResponse } from "next/server";
import { apiError } from "@/server/http";
import { getProviderKey } from "@/server/provider-secrets";
import { availableGoogleVideoModels } from "@/server/providers/video/google";

export const runtime = "nodejs";

export async function GET() {
  try {
    const key = await getProviderKey("google");
    if (!key) return NextResponse.json({ models: [], connected: false });
    return NextResponse.json({ models: await availableGoogleVideoModels(key), connected: true });
  } catch (error) {
    return apiError(error, 400);
  }
}
