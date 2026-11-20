import { Injectable } from '@nestjs/common';
import { LiveChatSettingsService } from '../../inbox/settings/live-chat-settings.service.js';
import { SettingsService } from '../../settings/settings.service.js';

/**
 * Keywords flows may not use as triggers (FR-021): 001 opt-out and opt-in keywords and the 002
 * "talk to a person" keywords. Read fresh each time, as the inbound handler does.
 */
@Injectable()
export class ReservedKeywords {
  constructor(
    private readonly settings: SettingsService,
    private readonly liveChat: LiveChatSettingsService,
  ) {}

  async list(): Promise<string[]> {
    const [company, liveChat] = await Promise.all([this.settings.get(), this.liveChat.get()]);
    return [...company.optOutKeywords, ...company.optInKeywords, ...liveChat.humanKeywords];
  }
}
