import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/http";
import { enqueueAssembly } from "@/server/movie/queue";
import { query } from "@/server/db";
import { signedObjectUrl } from "@/server/storage";

export const runtime = "nodejs";

const Body = z.object({ format: z.enum(["mp4", "mov"]).default("mp4"), resolution: z.enum(["720p", "1080p", "4k"]), sceneId: z.string().uuid().optional() });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const exportId = new URL(request.url).searchParams.get("exportId");
    if (!exportId) return NextResponse.json({ error: "Не указан экспорт." }, { status: 400 });
    const rows = await query<{ state: string; storage_key: string | null; format: string }>("SELECT state,storage_key,format FROM exports WHERE id=$1 AND project_id=$2", [exportId, id]);
    if (!rows[0]) return NextResponse.json({ error: "Экспорт не найден." }, { status: 404 });
    const url = rows[0].state === "completed" && rows[0].storage_key
      ? await signedObjectUrl(rows[0].storage_key, 300, `CineForge-${exportId}.${rows[0].format}`)
      : null;
    return NextResponse.json({ state: rows[0].state, url });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = Body.parse(await request.json());
    const result = await enqueueAssembly({ projectId: id, ...body });
    return NextResponse.json(result, { status: result.state === "completed" ? 200 : 202 });
  } catch (error) {
    return apiError(error, 400);
  }
}
