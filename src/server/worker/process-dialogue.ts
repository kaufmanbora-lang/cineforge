import { query } from "@/server/db";
import { enqueueAutomaticAssemblyIfReady } from "@/server/movie/queue";

/**
 * Compatibility handler for dialogue-patch envelopes created by older builds.
 * CineForge no longer creates a separate TTS soundtrack: Google-generated
 * synchronized dialogue is the authoritative audio. The original video asset
 * and its frames stay active, and the free assembly pipeline may continue.
 */
export async function processDialoguePatch(databaseJobId: string) {
  const rows = await query<{ id: string; project_id: string }>(
    `UPDATE jobs SET state='cancelled',completed_at=now(),last_error=NULL,updated_at=now(),
       result=COALESCE(result,'{}'::jsonb) || '{"skipped":true,"nativeGoogleAudioPreserved":true}'::jsonb
     WHERE id=$1 AND type='dialogue-patch' AND state IN ('planned','queued','retrying','generating','validating')
     RETURNING id,project_id`,
    [databaseJobId],
  );
  const job = rows[0];
  if (!job) return { skipped: true, nativeGoogleAudioPreserved: true };
  await enqueueAutomaticAssemblyIfReady(job.project_id);
  return { skipped: true, nativeGoogleAudioPreserved: true };
}
