import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Validates a request part with a zod schema; ZodError is rendered as 422 by the filter. */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    return this.schema.parse(value);
  }
}
