import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
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
  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Remote media download failed with HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(contentLength) || contentLength <= 0) throw new Error("Remote media response did not include a valid Content-Length header.");
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
  const contentType = response.headers.get("content-type") ?? "video/mp4";
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

export async function signedObjectUrl(key: string, expiresIn = 900): Promise<string> {
  await ensureBucket();
  return getSignedUrl(
    publicS3(),
    new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }),
    { expiresIn },
  );
}
