import { createHash } from "node:crypto";
import { query, transaction } from "@/server/db";
import { assembleMovie } from "@/server/movie/ffmpeg";
import { putObject, signedObjectUrl } from "@/server/storage";

interface AssemblyJobRow {
  id: string;
  project_id: string;
  payload: { format: "mp4" | "mov"; resolution: "720p" | "1080p" | "4k"; exportId: string };
}

export async function processAssembly(databaseJobId: string) {
  const jobs = await query<AssemblyJobRow>("SELECT * FROM jobs WHERE id=$1", [databaseJobId]);
  const job = jobs[0];
  if (!job) throw new Error("Assembly job not found.");
  await query("UPDATE jobs SET state='generating',started_at=COALESCE(started_at,now()),attempt=attempt+1 WHERE id=$1", [job.id]);
  const assets = await query<{ storage_key: string; shot_id: string; checksum: string; duration_seconds: number }>(
    `SELECT a.storage_key,a.shot_id,a.checksum,sh.duration_seconds FROM generation_assets a
     JOIN shot_versions sv ON sv.id=a.shot_version_id AND sv.active=true
     JOIN shots sh ON sh.id=a.shot_id JOIN scenes s ON s.id=sh.scene_id
     WHERE a.project_id=$1 AND a.kind='video' ORDER BY s.number,sh.sequence`,
    [job.project_id],
  );
  if (!assets.length) throw new Error("No completed shot assets are available for export.");
  const clips = [] as Array<{ bytes: Uint8Array; extension: string; durationSeconds: number }>;
  for (const asset of assets) {
    const response = await fetch(await signedObjectUrl(asset.storage_key));
    if (!response.ok) throw new Error(`Failed to download ${asset.shot_id} for assembly.`);
    clips.push({ bytes: new Uint8Array(await response.arrayBuffer()), extension: "mp4", durationSeconds: Number(asset.duration_seconds) });
  }
  const assembled = await assembleMovie({ clips, resolution: job.payload.resolution, outputFormat: job.payload.format });
  const bytes = assembled.bytes;
  const duplicateChecksums = assets.filter((asset, index) => assets.findIndex((candidate) => candidate.checksum === asset.checksum) !== index).map((asset) => asset.shot_id);
  const qcReport = { ...assembled.qc, duplicateShotIds: [...new Set(duplicateChecksums)], passed: assembled.qc.passed && duplicateChecksums.length === 0 };
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const storageKey = `projects/${job.project_id}/exports/${job.payload.exportId}.${job.payload.format}`;
  await putObject(storageKey, bytes, job.payload.format === "mov" ? "video/quicktime" : "video/mp4");
  await transaction(async (db) => {
    await db.query("UPDATE exports SET state=$2::job_state,storage_key=$3,completed_at=now(),qc_report=$4 WHERE id=$1", [
      job.payload.exportId,
      qcReport.passed ? "completed" : "failed",
      storageKey,
      JSON.stringify({ ...qcReport, checksum }),
    ]);
    await db.query("UPDATE jobs SET state=$2::job_state,completed_at=now(),result=$3,last_error=$4 WHERE id=$1", [job.id, qcReport.passed ? "completed" : "failed", JSON.stringify({ storageKey, checksum, qcReport }), qcReport.passed ? null : JSON.stringify({ code: "FINAL_QC_FAILED", issues: qcReport.issues })]);
    await db.query("UPDATE projects SET status=$2::project_status,progress=CASE WHEN $2='completed' THEN 100 ELSE progress END,final_movie_storage_key=CASE WHEN $2='completed' THEN $3 ELSE final_movie_storage_key END,last_error=$4 WHERE id=$1", [job.project_id, qcReport.passed ? "completed" : "failed", storageKey, qcReport.passed ? null : JSON.stringify({ code: "FINAL_QC_FAILED", issues: qcReport.issues })]);
    await db.query("INSERT INTO checkpoints (project_id,event_type,snapshot) VALUES ($1,$2,$3)", [job.project_id, qcReport.passed ? "export-completed" : "export-qc-failed", JSON.stringify({ storageKey, checksum, qcReport })]);
  });
  if (!qcReport.passed) throw new Error(`Final QC failed: ${qcReport.issues.join("; ") || "duplicate shot content"}`);
  return { storageKey, checksum };
}
