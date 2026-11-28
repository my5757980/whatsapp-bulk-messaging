// Feature 010 (research R12, FR-033): the blue tick (official business account) checklist, in our own
// words, from Meta's current eligibility list. Meta decides; the platform only guides and records.

export interface GuideLink {
  label: string;
  url: string;
}

export interface ObaStep {
  id: string;
  title: string;
  body: string;
  links: GuideLink[];
  optional?: boolean;
}

/** When the steps were last compared with Meta's pages. */
export const OBA_CHECKLIST_CHECKED_AT = '2026-11-28';

const OBA_DOCS: GuideLink = { label: 'Official business accounts (Meta)', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/official-business-accounts/' };

export const OBA_CHECKLIST_STEPS: readonly ObaStep[] = [
  {
    id: 'policy',
    title: 'Follow the WhatsApp Business Messaging Policy',
    body: 'Meta only reviews accounts that send what people asked for and respect opt-outs. Keep the quality rating green before you apply.',
    links: [{ label: 'WhatsApp Business Policy', url: 'https://business.whatsapp.com/policy' }],
  },
  {
    id: 'thirty-days',
    title: 'Use the number on the platform for at least 30 days',
    body: 'The number must have been registered on the WhatsApp Business Platform for 30 days or more when you apply.',
    links: [OBA_DOCS],
  },
  {
    id: 'business-verification',
    title: 'Verify the business portfolio',
    body: 'Complete Business Verification for the portfolio that owns the WhatsApp account, with the company\'s legal name, address and documents.',
    links: [OBA_DOCS],
  },
  {
    id: 'two-step',
    title: 'Turn on two-step verification for the number',
    body: 'Set a six-digit PIN for the number in WhatsApp Manager. Keep it safe: it is also needed to move or delete the number.',
    links: [{ label: 'Business phone numbers (Meta)', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers' }],
  },
  {
    id: 'display-name',
    title: 'Have an approved display name',
    body: 'The name shown on the number must be approved. It should match the business\'s brand on its website and signs.',
    links: [{ label: 'About the display name (Meta)', url: 'https://www.facebook.com/business/help/338047025165344' }],
  },
  {
    id: 'profile',
    title: 'Complete the business profile',
    body: 'Fill in the picture, about text, description, address, email, category and website here, so reviewers and customers see a real business.',
    links: [],
    optional: true,
  },
  {
    id: 'public-presence',
    title: 'Collect public articles about the business',
    body: 'Older Meta guidance asked for well-known businesses with news coverage. Links to independent articles can still help the review.',
    links: [{ label: 'About the display name (Meta)', url: 'https://www.facebook.com/business/help/338047025165344' }],
    optional: true,
  },
  {
    id: 'apply',
    title: 'Submit the request in WhatsApp Manager',
    body: 'Open the number in WhatsApp Manager and request an official business account. If Meta declines, a new request can be sent after 30 days.',
    links: [OBA_DOCS],
  },
];

export const OBA_STEP_IDS = OBA_CHECKLIST_STEPS.map((s) => s.id);
