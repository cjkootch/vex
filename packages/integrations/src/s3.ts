import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

export interface S3UploaderDeps {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Thin S3 wrapper. Vex uses S3 for transcript blobs (and, later, document
 * bodies). In local dev the endpoint is Localstack; in prod it's AWS S3 or
 * R2. Object keys are tenant-prefixed so a misconfigured policy can't leak
 * cross-tenant data.
 */
export class S3Uploader {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(deps: S3UploaderDeps) {
    const config: S3ClientConfig = {
      region: deps.region,
      credentials: {
        accessKeyId: deps.accessKeyId,
        secretAccessKey: deps.secretAccessKey,
      },
    };
    if (deps.endpoint) {
      config.endpoint = deps.endpoint;
      config.forcePathStyle = true;
    }
    this.client = new S3Client(config);
    this.bucket = deps.bucket;
  }

  async putText(key: string, body: string, contentType = "text/plain"): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getText(key: string): Promise<string> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!out.Body) throw new Error(`s3 object ${key} has no body`);
    return out.Body.transformToString();
  }

  get bucketName(): string {
    return this.bucket;
  }
}

export function transcriptObjectKey(tenantId: string, sessionId: string): string {
  return `transcripts/${tenantId}/${sessionId}.txt`;
}
