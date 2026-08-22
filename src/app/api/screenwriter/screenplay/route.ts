import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/http";
import { generateStructuredMoviePlan } from "@/server/providers/openai";
import { persistMoviePlan } from "@/server/movie/repository";
import { query } from "@/server/db";
import { adaptMoviePlanPrompts } from "@/server/providers/video/prompt-adapters";

export const runtime = "nodejs";
export const maxDuration = 800;

const Body = z.object({ projectId: z.string().uuid(), idea: z.string().min(10), durationSeconds: z.number().int().min(1).max(3_600).optional() });

export async function POST(request: Request) {
  try {
    const body = Body.parse(await request.json());
    const projects = await query<{ model_id: string; duration_seconds: number }>("SELECT model_id,duration_seconds FROM projects WHERE id=$1", [body.projectId]);
    if (!projects[0]) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const plan = adaptMoviePlanPrompts(await generateStructuredMoviePlan({ ...body, durationSeconds: projects[0].duration_seconds }), projects[0].model_id);
    await persistMoviePlan(plan);
    return NextResponse.json({ plan });
  } catch (error) {
    return apiError(error, 400);
  }
}
