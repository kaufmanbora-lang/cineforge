import { Worker } from "bullmq";
import { MOVIE_QUEUE, recoverInterruptedJobs, redisConnection } from "@/server/movie/queue";
import { processShot } from "./process-shot";
import { processDialoguePatch } from "./process-dialogue";
import { processAssembly } from "./process-assembly";
import { env } from "@/server/env";

await recoverInterruptedJobs();

const worker = new Worker(
  MOVIE_QUEUE,
  async (job) => {
    const databaseJobId = String(job.data.databaseJobId);
    if (job.name === "dialogue-patch") return processDialoguePatch(databaseJobId);
    if (job.name === "assemble-movie") return processAssembly(databaseJobId);
    return processShot(databaseJobId);
  },
  { connection: redisConnection(), concurrency: env().WORKER_CONCURRENCY },
);

worker.on("completed", (job) => process.stdout.write(`Completed ${job.id}\n`));
worker.on("failed", (job, error) => process.stderr.write(`Failed ${job?.id}: ${error.message}\n`));

async function shutdown() {
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
