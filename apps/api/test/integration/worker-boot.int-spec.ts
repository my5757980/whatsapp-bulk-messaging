import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { WorkerModule } from '../../src/worker.module.js';

// The worker process builds its own module graph without the API's modules. Integration tests
// load both together, so a provider that only resolves with API modules (e.g. one needing
// AuthService) would pass every test and still stop the worker from booting. Regression test.
describe('worker module', () => {
  it('resolves every provider without the API modules', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    expect(moduleRef.get(WorkerModule)).toBeInstanceOf(WorkerModule);
    await moduleRef.close();
  });
});
