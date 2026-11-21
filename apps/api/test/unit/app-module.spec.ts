import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import '../setup/env.js';

// Every provider and controller resolves its dependencies. Nest checks this while compiling, before
// any database or Redis call, so a wiring mistake shows up here instead of failing every integration
// test and the container smoke test in CI (as it did once in 004 US2).
describe('application wiring', () => {
  it('compiles the HTTP app as main.ts starts it', async () => {
    const { AppModule } = await import('../../src/app.module.js');
    expect(await Test.createTestingModule({ imports: [AppModule] }).compile()).toBeDefined();
  }, 120_000);

  it('compiles the worker as worker.ts starts it', async () => {
    const { WorkerModule } = await import('../../src/worker.module.js');
    expect(await Test.createTestingModule({ imports: [WorkerModule] }).compile()).toBeDefined();
  }, 120_000);

  it('compiles the HTTP app and the worker services together, as the integration tests run them', async () => {
    const { AppModule } = await import('../../src/app.module.js');
    const { ProcessorRegistry } = await import('../../src/common/queue/processor.registry.js');
    const { WorkerFeaturesModule } = await import('../../src/worker-features.module.js');

    @Global()
    @Module({ providers: [{ provide: ProcessorRegistry, useValue: { register: () => undefined, registerHandler: () => undefined, stop: async () => undefined, isRunning: () => false } }], exports: [ProcessorRegistry] })
    class StubRuntimeModule {}

    expect(await Test.createTestingModule({ imports: [AppModule, StubRuntimeModule, WorkerFeaturesModule] }).compile()).toBeDefined();
  }, 120_000);
});
