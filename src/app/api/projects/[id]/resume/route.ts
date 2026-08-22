import { NextResponse } from "next/server";
import { apiError } from "@/server/http";
import { resumeProjectJobs } from "@/server/movie/queue";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return NextResponse.json({ resumed: await resumeProjectJobs(id), projectId: id });
  } catch (error) {
    return apiError(error);
  }
}
