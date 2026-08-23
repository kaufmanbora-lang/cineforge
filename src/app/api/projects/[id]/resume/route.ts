import { NextResponse } from "next/server";
import { apiError } from "@/server/http";
import { resumeProjectJobs } from "@/server/movie/queue";
import { query } from "@/server/db";
import { env } from "@/server/env";
import { assertRateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertRateLimit(request, "project resume", 20, 60_000);
    const { id } = await context.params;
    const projects = await query<{ id: string }>("SELECT id FROM projects WHERE id=$1 AND workspace_id=$2", [id, env().DEFAULT_WORKSPACE_ID]);
    if (!projects[0]) return NextResponse.json({ error: "Проект не найден." }, { status: 404 });
    return NextResponse.json({ resumed: await resumeProjectJobs(id, { manual: true }), projectId: id });
  } catch (error) {
    return apiError(error);
  }
}
