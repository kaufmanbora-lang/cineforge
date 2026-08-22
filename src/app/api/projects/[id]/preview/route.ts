import { NextResponse } from "next/server";
import { apiError } from "@/server/http";
import { query } from "@/server/db";
import { signedObjectUrl } from "@/server/storage";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const projectRows = await query<Record<string, unknown> & { preview_storage_key: string | null; final_movie_storage_key: string | null }>("SELECT * FROM projects WHERE id=$1", [id]);
    if (!projectRows[0]) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const assets = await query<{ shot_id: string; scene_id: string; storage_key: string; duration_seconds: string; continuity_score: string | null; version: number }>(
      `SELECT a.shot_id,a.scene_id,a.storage_key,a.duration_seconds,sv.continuity_score,sv.version
       FROM generation_assets a JOIN shot_versions sv ON sv.id=a.shot_version_id AND sv.active=true
       JOIN shots sh ON sh.id=a.shot_id JOIN scenes s ON s.id=sh.scene_id
       WHERE a.project_id=$1 AND a.kind='video' ORDER BY s.number,sh.sequence`,
      [id],
    );
    const clips = await Promise.all(assets.map(async (asset) => ({ ...asset, url: await signedObjectUrl(asset.storage_key) })));
    const movieKey = projectRows[0].final_movie_storage_key ?? projectRows[0].preview_storage_key;
    return NextResponse.json({ project: projectRows[0], clips, movieUrl: movieKey ? await signedObjectUrl(movieKey) : null });
  } catch (error) {
    return apiError(error);
  }
}
