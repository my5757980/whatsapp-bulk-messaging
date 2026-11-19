import { Readable } from 'node:stream';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';

/**
 * S3-compatible object storage (MinIO locally) for uploads, error reports and media (T040).
 * Downloads are streamed through the API instead of presigned URLs, so access stays behind RBAC.
 */
@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.bucket = config.S3_BUCKET;
    this.s3 = new S3Client({
      region: config.S3_REGION,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}),
      ...(config.S3_ACCESS_KEY && config.S3_SECRET_KEY
        ? { credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY } }
        : {}),
    });
  }

  /** Creates the bucket when missing (local MinIO); a no-op when it already exists. */
  async ensureBucket(): Promise<'exists' | 'created'> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return 'exists';
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404) throw error;
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
      return 'created';
    }
  }

  async put(key: string, body: Buffer | string, contentType?: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ...(contentType ? { ContentType: contentType } : {}) }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!(out.Body instanceof Readable)) throw new Error(`Object ${key} has no readable body`);
    return out.Body;
  }

  async getBuffer(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.getStream(key)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  /** Keys under a prefix last modified before the cutoff (paged ListObjectsV2). */
  async listKeysOlderThan(prefix: string, cutoff: Date): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of page.Contents ?? []) if (o.Key && o.LastModified && o.LastModified < cutoff) keys.push(o.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
