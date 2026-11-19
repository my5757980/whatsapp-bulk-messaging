import { Global, Module } from '@nestjs/common';
import { MetaGraphClient } from './meta-graph.client.js';

@Global()
@Module({ providers: [MetaGraphClient], exports: [MetaGraphClient] })
export class MetaModule {}
