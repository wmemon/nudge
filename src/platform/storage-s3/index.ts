import { S3Client, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { config } from '../config/index.js'
import { createLogger } from '../observability/index.js'

const log = createLogger({ module: 'storage-s3' })

// ── Client factory ─────────────────────────────────────────────────────────────

let _client: S3Client | null = null

/**
 * Returns the singleton S3Client.
 * When S3_ENDPOINT_URL is set, routes to MinIO for local dev.
 * Real AWS is used in staging/production.
 */
export function createS3Client(): S3Client {
  if (_client) return _client

  _client = new S3Client({
    region: config.AWS_REGION,
    credentials: {
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    },
    ...(config.S3_ENDPOINT_URL && {
      endpoint: config.S3_ENDPOINT_URL,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    }),
  })

  return _client
}

/**
 * Uploads a buffer to S3 under the given key.
 * Returns the number of bytes written (from the buffer; not from the S3 response).
 * Never logs the buffer content (OAC-002).
 */
export async function uploadObject(params: {
  key:         string
  body:        Buffer
  contentType: string
}): Promise<{ sizeBytes: number }> {
  const client = createS3Client()
  await client.send(new PutObjectCommand({
    Bucket:      config.S3_BUCKET,
    Key:         params.key,
    Body:        params.body,
    ContentType: params.contentType,
  }))
  return { sizeBytes: params.body.byteLength }
}

/**
 * Generates a presigned GET URL for an S3 object.
 * TTL is taken from config.S3_PRESIGN_TTL_SECONDS (default 86400 = 24h, Q4.R6).
 *
 * IMPORTANT: The returned URL must never be written to logs, Sentry context,
 * or error messages — pass it directly to the delivery function (OAC-002).
 */
export async function generatePresignedGetUrl(key: string): Promise<string> {
  const client = createS3Client()
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
    { expiresIn: config.S3_PRESIGN_TTL_SECONDS },
  )
}

/**
 * Deletes a batch of S3 objects by key (account deletion — Q10.R1, ADR §7).
 *
 * - No-op when keys is empty (avoids a malformed AWS request).
 * - Per-object errors are logged at warn and swallowed — partial S3 cleanup
 *   must not block the Postgres cascade that removes the user's data.
 * - Never logs key values in the summary line; logs counts only (OAC-002).
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return

  const client = createS3Client()
  const result = await client.send(new DeleteObjectsCommand({
    Bucket: config.S3_BUCKET,
    Delete: {
      Objects: keys.map((Key) => ({ Key })),
      Quiet:   false,   // include each deleted key in response so we can inspect Errors
    },
  }))

  if (result.Errors && result.Errors.length > 0) {
    for (const e of result.Errors) {
      // Warn but do not throw — orphaned S3 keys are acceptable; blocking Postgres deletion is not
      log.warn({ event: 's3.delete_objects.key_error', key: e.Key ?? '(unknown)', code: e.Code, message: e.Message })
    }
  }
}

/**
 * Lightweight bucket reachability check — HeadBucket.
 * NOT included in /ready (Decision D6); available for ops use only.
 */
export async function checkStorage(): Promise<{ ok: boolean }> {
  try {
    const client = createS3Client()
    await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }))
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
