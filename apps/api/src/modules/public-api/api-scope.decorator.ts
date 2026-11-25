import { SetMetadata } from '@nestjs/common';
import type { ApiKeyScope } from '@wbm/shared';

// The API key permission a public route needs (feature 006, FR-010, research R4). Checked by
// ApiKeyGuard; a key without it gets 403 insufficient_scope.
export const API_SCOPE = 'wbm:api-scope';

export const RequireScope = (scope: ApiKeyScope) => SetMetadata(API_SCOPE, scope);
