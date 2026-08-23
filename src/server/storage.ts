import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "./env";

let client: S3Client | undefined;
let publicClient: S3Client | undefined;
let bucketPromise: Promise<void> | undefined;

function endpoint(value: string, publicAccess = false): string {
  if (/^https?:\/\//i.test(value)) return value;
  return `${publicAccess || value.endsWith(".onrender.com") ? "https" : "http"}://${value}`;
}

function createClient(endpointValue: string, publicAccess = false): S3Client {
  return new S3Client({
    endpoint: endpoint(endpointValue, publicAccess),
    region: env().S3_REGION,
    forcePathStyle: env().S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: env().S3_ACCESS_KEY, secretAccessKey: env().S3_SECRET_KEY },
  });
}

function s3(): S3Client {
  client ??= createClient(env().S3_ENDPOINT);
  return client;
}

function publicS3(): S3Client {
  publicClient ??= createClient(env().S3_PUBLIC_ENDPOINT ?? env().S3_ENDPOINT, Boolean(env().S3_PUBLIC_ENDPOINT));
  return publicClient;
}

async function ensureBucket(): Promise<void> {
  bucketPromise ??= (async () => {
    try {
      await s3().send(new HeadBucketCommand({ Bucket: env().S3_BUCKET }));
    } catch {
      try {
        await s3().send(new CreateBucketCommand({ Bucket: env().S3_BUCKET }));
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 409) throw error;
      }
    }
  })();
  return bucketPromise;
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await ensureBucket();
  await s3().send(new PutObjectCommand({
    Bucket: env().S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: env().S3_ENDPOINT.includes("amazonaws.com") ? "AES256" : undefined,
  }));
}

export async function putRemoteObject(
  key: string,
  url: string,
  headers: Record<string, string>,
): Promise<{ byteSize: number; checksum: string; contentType: string }> {
  await ensureBucket();
  const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    throw Object.assign(new Error(`Remote media upload staging failed with HTTP ${response.status}${details ? `: ${details}` : "."}`), { status: response.status, code: "UPLOAD_FAILED" });
  }
  if (!response.body) throw Object.assign(new Error("Remote media upload staging returned an empty response body."), { code: "UPLOAD_FAILED" });
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  const contentType = response.headers.get("content-type") ?? "video/mp4";
  // Some Google signed media URLs are chunked and omit Content-Length. The S3
  // streaming uploader needs a known size, so spool only that uncommon response
  // shape to a temporary file instead of rejecting an otherwise valid result.
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    const tempRoot = await mkdtemp(join(tmpdir(), "cineforge-remote-"));
    const filePath = join(tempRoot, "provider-output.mp4");
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(filePath, { flags: "wx" }),
      );
      return await putFileObject(key, filePath, contentType);
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const hash = createHash("sha256");
  let byteSize = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const body = Readable.fromWeb(response.body as never).pipe(counter);
  await s3().send(new PutObjectCommand({
    Bucket: env().S3_BUCKET,
    Key: key,
    Body: body,
    ContentLength: contentLength,
    ContentType: contentType,
    ServerSideEncryption: env().S3_ENDPOINT.includes("amazonaws.com") ? "AES256" : undefined,
  }));
  if (byteSize !== contentLength) throw new Error(`Remote media stream ended at ${byteSize} of ${contentLength} bytes.`);
  return { byteSize, checksum: hash.digest("hex"), contentType };
}

export async function putFileObject(
  key: string,
  filePath: string,
  contentType: string,
): Promise<{ byteSize: number; checksum: string; contentType: string }> {
  await ensureBucket();
  const file = await stat(filePath);
  if (!file.isFile() || file.size <= 0) throw new Error("Generated video file is empty.");
  const hash = createHash("sha256");
  let byteSize = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const body = createReadStream(filePath).pipe(counter);
  await s3().send(new PutObjectCommand({
    Bucket: env().S3_BUCKET,
    Key: key,
    Body: body,
    ContentLength: file.size,
    ContentType: contentType,
    ServerSideEncryption: env().S3_ENDPOINT.includes("amazonaws.com") ? "AES256" : undefined,
  }));
  if (byteSize !== file.size) throw new Error(`Generated video stream ended at ${byteSize} of ${file.size} bytes.`);
  return { byteSize, checksum: hash.digest("hex"), contentType };
}

export async function getObjectIfExists(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  await ensureBucket();
  try {
    const result = await s3().send(new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
    if (!result.Body) return null;
    return {
      bytes: await result.Body.transformToByteArray(),
      contentType: result.ContentType ?? "video/mp4",
    };
  } catch (error) {
    const record = typeof error === "object" && error ? error as { name?: string; $metadata?: { httpStatusCode?: number } } : {};
    if (record.name === "NoSuchKey" || record.name === "NotFound" || record.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await ensureBucket();
  await s3().send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
}

export async function getObjectToFile(key: string, filePath: string): Promise<{ byteSize: number; contentType: string }> {
  await ensureBucket();
  const result = await s3().send(new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
  if (!result.Body) throw new Error(`Object ${key} has no readable body.`);
  await pipeline(
    Readable.fromWeb(result.Body.transformToWebStream() as never),
    createWriteStream(filePath, { flags: "wx" }),
  );
  const file = await stat(filePath);
  if (!file.isFile() || file.size <= 0) throw new Error(`Object ${key} downloaded as an empty file.`);
  return { byteSize: file.size, contentType: result.ContentType ?? "application/octet-stream" };
}

export async function signedObjectUrl(key: string, expiresIn = 900, downloadName?: string): Promise<string> {
  await ensureBucket();
  return getSignedUrl(
    publicS3(),
    new GetObjectCommand({
      Bucket: env().S3_BUCKET,
      Key: key,
      ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName.replaceAll('"', "")}"` : undefined,
    }),
    { expiresIn },
  );
}
