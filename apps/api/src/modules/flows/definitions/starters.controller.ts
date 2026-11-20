import { Controller, Get } from '@nestjs/common';
import { FLOW_STARTERS } from '@wbm/shared';
import { Require } from '../../../common/auth/permissions.guard.js';

/** GET /flow-starters (003 T080, FR-037): the starter flows written by us. */
@Controller('flow-starters')
export class FlowStartersController {
  @Get()
  @Require('flows.manage')
  list() {
    return FLOW_STARTERS.map((s) => ({ key: s.key, name: s.name, description: s.description, stepCount: s.graph.steps.length, attributes: s.attributes.map((a) => a.key) }));
  }
}
