import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import type { AttributeDefinition } from '../../generated/prisma/client.js';

const CreateAttributeSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'use lower-case letters, digits and underscores, starting with a letter'),
    label: z.string().trim().min(1).max(60),
    type: z.enum(['TEXT', 'NUMBER', 'DATE', 'BOOLEAN']),
  })
  .strict();
const RenameAttributeSchema = z.object({ label: z.string().trim().min(1).max(60) }).strict();

const toDto = (a: AttributeDefinition) => ({ id: a.id, key: a.key, label: a.label, type: a.type });

/** Custom attribute definitions (FR-011, T121). The key and type are fixed once created. */
@Controller('attributes')
export class AttributesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Require('contacts.view')
  async list() {
    return (await this.prisma.attributeDefinition.findMany({ orderBy: { key: 'asc' } })).map(toDto);
  }

  @Post()
  @Require('attributes.manage')
  async create(@Body(new ZodValidationPipe(CreateAttributeSchema)) body: z.infer<typeof CreateAttributeSchema>) {
    try {
      return toDto(await this.prisma.attributeDefinition.create({ data: body }));
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('An attribute with this key already exists');
      throw error;
    }
  }

  @Patch(':id')
  @Require('attributes.manage')
  async rename(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(RenameAttributeSchema)) body: z.infer<typeof RenameAttributeSchema>) {
    const { count } = await this.prisma.attributeDefinition.updateMany({ where: { id }, data: { label: body.label } });
    if (!count) throw AppError.notFound('Attribute not found');
    return toDto(await this.prisma.attributeDefinition.findUniqueOrThrow({ where: { id } }));
  }

  /** Deletes the definition and removes its values from every contact. */
  @Delete(':id')
  @Require('attributes.manage')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const attribute = await this.prisma.attributeDefinition.findUnique({ where: { id } });
    if (!attribute) throw AppError.notFound('Attribute not found');
    await this.prisma.$transaction([
      this.prisma.$executeRaw`UPDATE contacts SET attributes = attributes - ${attribute.key}, updated_at = now() WHERE (attributes -> ${attribute.key}) IS NOT NULL`,
      this.prisma.attributeDefinition.delete({ where: { id } }),
    ]);
  }
}
