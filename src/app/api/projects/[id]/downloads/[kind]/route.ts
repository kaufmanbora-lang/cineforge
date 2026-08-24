import { NextResponse } from "next/server";
import { apiError } from "@/server/http";
import { latestMoviePlan } from "@/server/movie/repository";
import { query } from "@/server/db";
import { signedObjectUrl } from "@/server/storage";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string; kind: string }> }) {
  try {
    const { id, kind } = await context.params;
    const plan = await latestMoviePlan(id);
    if (!plan) return NextResponse.json({ error: "No screenplay is available." }, { status: 404 });
    const safeTitle = plan.summary.title.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-|-$/g, "") || "movie";
    if (kind.startsWith("shot-")) {
      const shotId = kind.slice("shot-".length);
      if (!shotId) return NextResponse.json({ error: "Не указан кадр для скачивания." }, { status: 400 });
      const rows = await query<{ storage_key: string; sequence: number }>(
        `SELECT a.storage_key,s.sequence FROM generation_assets a
         JOIN shot_versions sv ON sv.id=a.shot_version_id AND sv.active=true
         JOIN shots s ON s.id=a.shot_id
         WHERE a.project_id=$1 AND a.shot_id=$2 AND a.kind='video'
         ORDER BY a.created_at DESC LIMIT 1`,
        [id, shotId],
      );
      if (!rows[0]) return NextResponse.json({ error: "Готовое видео этого кадра не найдено." }, { status: 404 });
      return NextResponse.redirect(await signedObjectUrl(rows[0].storage_key, 300, `${safeTitle}-shot-${rows[0].sequence}.mp4`));
    }
    if (kind === "mp4" || kind === "mov") {
      const rows = await query<{ storage_key: string }>(
        "SELECT storage_key FROM exports WHERE project_id=$1 AND format=$2 AND state='completed' AND storage_key IS NOT NULL ORDER BY completed_at DESC LIMIT 1",
        [id, kind],
      );
      if (!rows[0]?.storage_key) return NextResponse.json({ error: `No completed ${kind.toUpperCase()} export is available.` }, { status: 404 });
      return NextResponse.redirect(await signedObjectUrl(rows[0].storage_key, 300, `${safeTitle}.${kind}`));
    }
    if (kind === "srt") {
      const entries: Array<{ start: number; end: number; text: string }> = [];
      let shotCursor = 0;
      for (const scene of plan.scenes) for (const shot of scene.shots) {
        for (const line of shot.audioContext.dialogue) entries.push({ start: shotCursor + line.startSeconds, end: shotCursor + line.startSeconds + line.durationSeconds, text: line.text });
        shotCursor += shot.durationSeconds;
      }
      const body = entries.map((entry, index) => `${index + 1}\n${srtTime(entry.start)} --> ${srtTime(entry.end)}\n${entry.text}\n`).join("\n");
      return new Response(body, { headers: downloadHeaders(`${safeTitle}.srt`, "application/x-subrip; charset=utf-8") });
    }
    if (kind === "screenplay") {
      const body = screenplayMarkdown(plan);
      return new Response(body, { headers: downloadHeaders(`${safeTitle}-screenplay.md`, "text/markdown; charset=utf-8") });
    }
    if (kind === "archive") {
      const [project, characters, locations, scenes, shots, checkpoints, jobs, exports] = await Promise.all([
        query("SELECT id,title,prompt,duration_seconds,model_id,resolution,aspect_ratio,status,progress,maximum_budget_usd,estimated_cost_usd,spent_usd,current_plan_version,created_at,updated_at FROM projects WHERE id=$1", [id]),
        query("SELECT id,name,bible,current_state,locks FROM characters WHERE project_id=$1", [id]),
        query("SELECT id,name,bible,current_state,locks FROM locations WHERE project_id=$1", [id]),
        query("SELECT id,number,title,duration_seconds,scene_state,continuity_state,content_hash,current_version FROM scenes WHERE project_id=$1 ORDER BY number", [id]),
        query("SELECT id,scene_id,sequence,duration_seconds,state,dependencies,generation_spec,audio_context,continuity_state,content_hash,current_version,retry_count,last_error FROM shots WHERE project_id=$1 ORDER BY created_at", [id]),
        query("SELECT sequence,event_type,completed_shot_ids,failed_shot_ids,pending_shot_ids,current_job_id,snapshot,created_at FROM checkpoints WHERE project_id=$1 ORDER BY sequence", [id]),
        query("SELECT id,type,state,idempotency_key,attempt,max_attempts,payload,result,last_error,created_at,completed_at FROM jobs WHERE project_id=$1 ORDER BY created_at", [id]),
        query("SELECT id,format,state,storage_key,qc_report,created_at,completed_at FROM exports WHERE project_id=$1 ORDER BY created_at", [id]),
      ]);
      const body = JSON.stringify({ format: "cineforge-project-archive", version: 1, exportedAt: new Date().toISOString(), project: project[0], moviePlan: plan, projectMemory: { characters, locations }, sceneGraph: { scenes, shots }, checkpoints, jobs, exports }, null, 2);
      return new Response(body, { headers: downloadHeaders(`${safeTitle}.cineforge.json`, "application/json; charset=utf-8") });
    }
    return NextResponse.json({ error: "Unsupported download type." }, { status: 404 });
  } catch (error) {
    return apiError(error);
  }
}

function srtTime(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const ms = milliseconds % 1000;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":") + `,${String(ms).padStart(3, "0")}`;
}

function screenplayMarkdown(plan: Awaited<ReturnType<typeof latestMoviePlan>> & {}) {
  if (!plan) return "";
  const lines = [`# ${plan.summary.title}`, "", `**Genre:** ${plan.summary.genre}`, `**Style:** ${plan.summary.style}`, `**Runtime:** ${plan.summary.durationSeconds} seconds`, "", plan.summary.synopsis, "", "## Characters", ""];
  for (const character of plan.characters) lines.push(`### ${character.name}`, "", `${character.age} · ${character.personality}`, "", character.backstory, "");
  lines.push("## Screenplay", "");
  for (const scene of plan.scenes) {
    const location = plan.locations.find((item) => item.id === scene.locationId)?.name ?? scene.locationId;
    lines.push(`### Scene ${scene.number} — ${scene.title}`, "", `*${location} · ${scene.timeOfDay} · ${scene.durationSeconds}s*`, "", scene.action, "");
    for (const shot of scene.shots) {
      lines.push(`**Shot ${shot.sequence} (${shot.durationSeconds}s):** ${shot.action}`, "");
      for (const dialogue of shot.audioContext.dialogue) lines.push(`> **${dialogue.characterName}:** ${dialogue.text}`, "");
    }
  }
  return lines.join("\n");
}

function downloadHeaders(filename: string, contentType: string): HeadersInit {
  return { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" };
}
