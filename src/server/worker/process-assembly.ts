import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, transaction } from "@/server/db";
import { assembleMovieFiles } from "@/server/movie/ffmpeg";
import { getObjectToFile, putFileObject } from "@/server/storage";

interface AssemblyJobRow {
  id: string;
  project_id: string;
  payload: { format: "mp4" | "mov"; resolution: "720p" | "1080p" | "4k"; exportId: string; sceneId?: string };
}

export async function processAssembly(databaseJobId: string) {
  const jobs = await query<AssemblyJobRow>(
    `UPDATE jobs SET state='generating',started_at=COALESCE(started_at,now()),attempt=attempt+1,updated_at=now()
     WHERE id=$1 AND state IN ('queued','retrying') RETURNING *`,
    [databaseJobId],
  );
  const job = jobs[0];
  if (!job) return { skipped: true };
  const heartbeat = setInterval(() => {
    void query("UPDATE jobs SET updated_at=now() WHERE id=$1 AND state='generating'", [job.id]).catch(() => undefined);
  }, 30_000);
  heartbeat.unref();
  const tempRoot = join(tmpdir(), `cineforge-assembly-${randomUUID()}`);
  try {
  await mkdir(tempRoot, { recursive: true });
  const assets = await query<{ storage_key: string; shot_id: string; checksum: string; duration_seconds: number }>(
    `SELECT a.storage_key,a.shot_id,a.checksum,sh.duration_seconds FROM generation_assets a
     JOIN shot_versions sv ON sv.id=a.shot_version_id AND sv.active=true
     JOIN shots sh ON sh.id=a.shot_id JOIN scenes s ON s.id=sh.scene_id
     WHERE a.project_id=$1 AND a.kind='video' AND sh.state<>'cancelled' AND ($2::text IS NULL OR s.id=$2) ORDER BY s.number,sh.sequence`,
    [job.project_id, job.payload.sceneId ?? null],
  );
  if (!assets.length) throw new Error("No completed shot assets are available for export.");
  const clips = await Promise.all(assets.map(async (asset, index) => {
    const filePath = join(tempRoot, `source-${index}.mp4`);
    await getObjectToFile(asset.storage_key, filePath);
    return { filePath, durationSeconds: Number(asset.duration_seconds) };
  }));
  const outputPath = join(tempRoot, `movie.${job.payload.format}`);
  const assembledQc = await assembleMovieFiles({ clips, resolution: job.payload.resolution, outputFormat: job.payload.format, outputPath });
  const duplicateChecksums = assets.filter((asset, index) => assets.findIndex((candidate) => candidate.checksum === asset.checksum) !== index).map((asset) => asset.shot_id);
  const qcReport = { ...assembledQc, duplicateShotIds: [...new Set(duplicateChecksums)], passed: assembledQc.passed && duplicateChecksums.length === 0 };
  const storageKey = `projects/${job.project_id}/exports/${job.payload.sceneId ? `scene-${job.payload.sceneId}-` : ""}${job.payload.exportId}.${job.payload.format}`;
  const stored = await putFileObject(storageKey, outputPath, job.payload.format === "mov" ? "video/quicktime" : "video/mp4");
  const checksum = stored.checksum;
  await transaction(async (db) => {
    await db.query("UPDATE exports SET state=$2::job_state,storage_key=$3,completed_at=now(),qc_report=$4 WHERE id=$1", [
      job.payload.exportId,
      qcReport.passed ? "completed" : "failed",
      storageKey,
      JSON.stringify({ ...qcReport, checksum }),
    ]);
    await db.query("UPDATE jobs SET state=$2::job_state,completed_at=now(),result=$3,last_error=$4 WHERE id=$1", [job.id, qcReport.passed ? "completed" : "failed", JSON.stringify({ storageKey, checksum, qcReport }), qcReport.passed ? null : JSON.stringify({ code: "FINAL_QC_FAILED", issues: qcReport.issues })]);
    if (!job.payload.sceneId) {
      await db.query("UPDATE projects SET status=$2::project_status,progress=CASE WHEN $2='completed' THEN 100 ELSE progress END,final_movie_storage_key=CASE WHEN $2='completed' THEN $3 ELSE final_movie_storage_key END,last_error=$4 WHERE id=$1", [job.project_id, qcReport.passed ? "completed" : "failed", storageKey, qcReport.passed ? null : JSON.stringify({ code: "FINAL_QC_FAILED", issues: qcReport.issues })]);
    }
    await db.query("INSERT INTO checkpoints (project_id,event_type,snapshot) VALUES ($1,$2,$3)", [job.project_id, qcReport.passed ? (job.payload.sceneId ? "scene-export-completed" : "export-completed") : "export-qc-failed", JSON.stringify({ storageKey, checksum, qcReport, sceneId: job.payload.sceneId ?? null })]);
  });
  return qcReport.passed
    ? { storageKey, checksum }
    : { storageKey, checksum, failed: true, issues: qcReport.issues };
  } finally {
    clearInterval(heartbeat);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
