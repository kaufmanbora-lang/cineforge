import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
