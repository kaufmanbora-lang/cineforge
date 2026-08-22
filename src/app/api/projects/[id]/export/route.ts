import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/http";
import { enqueueAssembly } from "@/server/movie/queue";

export const runtime = "nodejs";

const Body = z.object({ format: z.enum(["mp4", "mov"]).default("mp4"), resolution: z.enum(["720p", "1080p", "4k"]) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = Body.parse(await request.json());
    return NextResponse.json({ queued: true, ...(await enqueueAssembly({ projectId: id, ...body })) }, { status: 202 });
  } catch (error) {
    return apiError(error, 400);
  }
}
