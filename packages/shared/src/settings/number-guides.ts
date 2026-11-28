import type { GuideLink } from './oba-checklist.js';

// Feature 010 (research R12, FR-034): guides for moving a number to this platform and back to the
// WhatsApp Business app, in our own words, from Meta's pages.

export interface GuideStep {
  title: string;
  body: string;
  warning?: string;
}

export interface NumberGuide {
  id: 'move-here' | 'move-back';
  title: string;
  intro: string;
  steps: GuideStep[];
  links: GuideLink[];
  checkedAt: string;
}

export const NUMBER_GUIDES: readonly NumberGuide[] = [
  {
    id: 'move-here',
    title: 'Move a number here from another provider',
    intro: 'The number keeps working with WhatsApp; only the tool that sends and receives its messages changes. Plan a quiet hour for the switch.',
    steps: [
      { title: 'Tell the old provider', body: 'Ask them to release the number for migration and to confirm which WhatsApp Business Account it belongs to.' },
      {
        title: 'Get the two-step verification PIN',
        body: 'The number\'s six-digit PIN is needed to move it. Ask the old provider for it, or have them turn it off.',
        warning: 'Without the PIN, Meta cannot move the number until the PIN is reset, which can take days.',
      },
      {
        title: 'Know what moves and what does not',
        body: 'Templates and the quality rating stay with the WhatsApp Business Account. Chat history kept in the old provider\'s tool does not move; export it there first.',
      },
      { title: 'Connect the number here', body: 'Use Numbers → Connect a number and follow the wizard. Meta sends a code to the number to confirm it.' },
      { title: 'Check the number after the move', body: 'Open the number\'s profile: the display name should be approved and the quality rating should be the same as before.' },
    ],
    links: [
      { label: 'Migrate an existing number (Meta)', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/migrate-existing-whatsapp-number-to-a-business-account' },
      { label: 'Register a business phone number (Meta)', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration' },
    ],
    checkedAt: '2026-11-28',
  },
  {
    id: 'move-back',
    title: 'Move a number back to the WhatsApp Business app',
    intro: 'Use this only if the company stops using the platform for this number. The number leaves the WhatsApp Business Platform and can then be used in the app.',
    steps: [
      { title: 'Save what you need', body: 'Export contacts, reports and payments from the platform. Chat history in the platform does not move to the app.' },
      { title: 'Remove the number from the platform', body: 'Open the number here and remove it. You will be asked to type the number to confirm.', warning: 'Campaigns, flows and automations that use the number stop.' },
      {
        title: 'Delete the number in WhatsApp Manager',
        body: 'In WhatsApp Manager, open Account tools → Phone numbers and use the delete icon. The two-step verification PIN is needed.',
        warning: 'Meta only allows this when no paid messages were sent from the account in the last 30 days, and the number\'s templates and platform data are deleted.',
      },
      { title: 'Register the number in the app', body: 'After a few minutes, install the WhatsApp Business app and register the number with the code WhatsApp sends.' },
    ],
    links: [
      { label: 'Delete a number from the Business Platform (WhatsApp Help)', url: 'https://faq.whatsapp.com/209248051996804' },
      { label: 'Business phone numbers (Meta)', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers' },
    ],
    checkedAt: '2026-11-28',
  },
];
