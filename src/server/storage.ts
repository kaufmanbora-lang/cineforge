import "server-only";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

let client: S3Client | undefined;

function s3(): S3Client {
  client ??= new S3Client({
    endpoint: env().S3_ENDPOINT,
    region: env().S3_REGION,
    forcePathStyle: env().S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: env().S3_ACCESS_KEY, secretAccessKey: env().S3_SECRET_KEY },
  });
  return client;
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await s3().send(new PutObjectCommand({
    Bucket: env().S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: env().S3_ENDPOINT.includes("amazonaws.com") ? "AES256" : undefined,
  }));
}

export async function signedObjectUrl(key: string, expiresIn = 900): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }),
    { expiresIn },
  );
}
