import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'wbm:isPublic';

/** Skips the session and CSRF guards (auth endpoints, signed webhooks, ops endpoints). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
