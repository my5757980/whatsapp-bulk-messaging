import { z } from 'zod';

/** `page` / `pageSize` query parameters (contract components.parameters Page, PageSize). */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export function pageMeta(query: PageQuery, total: number) {
  return { page: query.page, pageSize: query.pageSize, total };
}
