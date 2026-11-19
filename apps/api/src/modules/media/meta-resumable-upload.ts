import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { StorageService } from '../../common/storage/storage.service.js';
import type { MediaAsset } from '../../generated/prisma/client.js';
import { describeMetaError } from '../meta/meta-error-classifier.js';
import { MetaApiError, MetaGraphClient } from '../meta/meta-graph.client.js';

/**
 * Uploads a template header sample with Meta's Resumable Upload API and returns the file handle
 * used as `example.header_handle` when the template is created (T139). Verified against Meta's
 * "Resumable Upload API" guide (Graph v27.0): POST /{app-id}/uploads?file_name&file_length&file_type
 * -> { id: "upload:<session>" }; POST /upload:<session> (Authorization: OAuth, file_offset: 0,
 * binary body) -> { h }.
 */
@Injectable()
export class MetaResumableUpload {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly meta: MetaGraphClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async uploadHeaderSample(asset: MediaAsset, token: string): Promise<string> {
    const appId = this.config.META_APP_ID;
    if (!appId) {
      throw AppError.validation('Media headers need the Meta app id to be configured on the server (META_APP_ID)', [
        { field: 'header.mediaAssetId', issue: 'media headers are not configured on this server' },
      ]);
    }
    const file = await this.storage.getBuffer(asset.storageKey);
    const name = asset.storageKey.split('/').pop() ?? 'header';
    try {
      const session = await this.meta.createUploadSession(token, appId, { name, length: file.length, type: asset.mimeType });
      const handle = await this.meta.uploadSessionData(token, session, file);
      await this.prisma.mediaAsset.update({ where: { id: asset.id }, data: { metaHeaderHandle: handle } });
      return handle;
    } catch (error) {
      const reason = error instanceof MetaApiError ? describeMetaError(error.code, error.message) : 'Could not reach Meta';
      throw AppError.validation(`Could not upload the header sample to Meta: ${reason}`, undefined, 'META_ERROR');
    }
  }
}
