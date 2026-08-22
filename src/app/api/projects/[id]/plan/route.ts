import { NextResponse } from "next/server";
import { apiError } from "@/server/http";
import { query } from "@/server/db";
import { generateStructuredMoviePlan } from "@/server/providers/openai";
import { persistMoviePlan } from "@/server/movie/repository";
import { adaptMoviePlanPrompts } from "@/server/providers/video/prompt-adapters";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const rows = await query<{ prompt: string; duration_seconds: number; model_id: string }>(
      "UPDATE projects SET status='planning' WHERE id=$1 RETURNING prompt,duration_seconds,model_id",
      [id],
    );
    if (!rows[0]) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const rawPlan = await generateStructuredMoviePlan({ projectId: id, idea: rows[0].prompt, durationSeconds: rows[0].duration_seconds });
    const plan = adaptMoviePlanPrompts(rawPlan, rows[0].model_id);
    await persistMoviePlan(plan);
    return NextResponse.json({ plan, scenes: plan.scenes.length, shots: plan.scenes.reduce((sum, scene) => sum + scene.shots.length, 0) });
  } catch (error) {
    return apiError(error);
  }
}
