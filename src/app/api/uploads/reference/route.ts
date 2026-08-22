import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/http";
import { putObject, signedObjectUrl } from "@/server/storage";
import { query } from "@/server/db";
import { assertRateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";
const ProjectId = z.string().uuid().optional();
const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(request: Request) {
  try {
    assertRateLimit(request, "reference upload", 30, 60_000);
    const body = await request.formData();
    const file = body.get("file");
    const projectId = ProjectId.parse(body.get("projectId") || undefined);
    if (!(file instanceof File)) return NextResponse.json({ error: "An image file is required." }, { status: 400 });
    if (!allowed.has(file.type)) return NextResponse.json({ error: "Only JPEG, PNG and WebP reference images are accepted." }, { status: 415 });
    if (file.size > 8 * 1024 * 1024) return NextResponse.json({ error: "Reference images are limited to 8 MB." }, { status: 413 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const storageKey = `projects/${projectId ?? "unassigned"}/references/${randomUUID()}.${extension}`;
    await putObject(storageKey, bytes, file.type);
    let assetId: string | null = null;
    if (projectId) {
      const rows = await query<{ id: string }>(
        `INSERT INTO generation_assets (project_id,kind,storage_key,mime_type,byte_size,checksum,metadata)
         VALUES ($1,'reference-image',$2,$3,$4,$5,$6)
         ON CONFLICT (project_id,checksum,kind) DO UPDATE SET metadata=EXCLUDED.metadata RETURNING id`,
        [projectId, storageKey, file.type, file.size, checksum, JSON.stringify({ originalName: file.name.slice(0, 180) })],
      );
      assetId = rows[0].id;
    }
    return NextResponse.json({ assetId, storageKey, url: await signedObjectUrl(storageKey), mimeType: file.type }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}
