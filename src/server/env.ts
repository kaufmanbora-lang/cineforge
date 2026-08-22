import "server-only";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_ENCRYPTION_KEY: z.string().optional(),
  DEFAULT_WORKSPACE_ID: z.string().uuid().default("00000000-0000-0000-0000-000000000001"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_SCREENWRITER_MODEL: z.string().default("gpt-5.6-sol"),
  OPENAI_PROMPT_MODEL: z.string().default("gpt-5.6-terra"),
  OPENAI_QC_MODEL: z.string().default("gpt-5.6-luna"),
  GEMINI_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().default("postgresql://cineforge:cineforge@localhost:5432/cineforge"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  S3_ENDPOINT: z.string().min(1).default("http://localhost:9000"),
  S3_PUBLIC_ENDPOINT: z.string().min(1).optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("cineforge"),
  S3_ACCESS_KEY: z.string().default("cineforge"),
  S3_SECRET_KEY: z.string().default("change-me-in-production"),
  S3_FORCE_PATH_STYLE: z.string().default("true"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  MAX_AUTO_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  QC_RETRY_THRESHOLD: z.coerce.number().min(0).max(100).default(75),
  QC_FLAG_THRESHOLD: z.coerce.number().min(0).max(100).default(90),
});

let cached: z.infer<typeof EnvSchema> | undefined;

export function env(): z.infer<typeof EnvSchema> {
  cached ??= EnvSchema.parse(process.env);
  return cached;
}
