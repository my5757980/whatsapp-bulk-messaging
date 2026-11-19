import { Global, Module } from '@nestjs/common';
import { TokenCipher } from '../crypto/token-cipher.js';
import { loadConfig, type AppConfig } from './config.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: TokenCipher,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new TokenCipher(config.TOKEN_ENCRYPTION_KEY),
    },
  ],
  exports: [APP_CONFIG, TokenCipher],
})
export class ConfigModule {}
