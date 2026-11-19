import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';

/** Tag names are stored trimmed and lower-cased, so uniqueness is case-insensitive. */
export const normaliseTag = (name: string) => name.trim().toLowerCase();

const TagSchema = z.object({ name: z.string().trim().min(1, 'is required').max(50) }).strict();

/** /tags (T122). */
@Controller('tags')
export class TagsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Require('contacts.view')
  async list() {
    const tags = await this.prisma.tag.findMany({ include: { _count: { select: { contacts: true } } }, orderBy: { name: 'asc' } });
    return tags.map((t) => ({ id: t.id, name: t.name, contactCount: t._count.contacts }));
  }

  @Post()
  @Require('contacts.manage')
  async create(@Body(new ZodValidationPipe(TagSchema)) body: z.infer<typeof TagSchema>) {
    try {
      const tag = await this.prisma.tag.create({ data: { name: normaliseTag(body.name) } });
      return { id: tag.id, name: tag.name, contactCount: 0 };
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('A tag with this name already exists');
      throw error;
    }
  }

  @Delete(':id')
  @Require('contacts.manage')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const { count } = await this.prisma.tag.deleteMany({ where: { id } });
    if (!count) throw AppError.notFound('Tag not found');
  }
}
