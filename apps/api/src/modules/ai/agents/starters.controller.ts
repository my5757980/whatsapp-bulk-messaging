import { Controller, Get } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { AgentsService } from './agents.service.js';

/** GET /ai-agent-starters (004 T094, FR-040, FR-041): our starter agents and which suggested attributes exist. */
@Controller('ai-agent-starters')
export class AgentStartersController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @Require('ai.manage')
  list() {
    return this.agents.starters();
  }
}
