// Feature 009 (research R12, FR-027): short guidelines for each section of the template editor and the
// common reasons Meta rejects templates, written in our own words from Meta's public pages. Maintainers
// edit this file; the editor's panel shows it as it is.

export const GUIDELINE_SECTIONS = ['category', 'variables', 'media', 'buttons', 'carousel', 'offer', 'authentication'] as const;
export type GuidelineSection = (typeof GUIDELINE_SECTIONS)[number];

export interface GuidelineEntry {
  title: string;
  points: readonly string[];
  /** When the points were last compared with Meta's pages. */
  checkedAt: string;
}

const CHECKED = '2026-11-27';

export const TEMPLATE_GUIDELINES: Readonly<Record<GuidelineSection, GuidelineEntry>> = {
  category: {
    title: 'Choosing the category',
    points: [
      'Utility is for messages about something the customer already started: an order, a booking, an account or a bill.',
      'Marketing is for everything that promotes: offers, news, invitations and reminders to buy again.',
      'Authentication is only for one-time codes, with Meta\'s fixed wording.',
      'Meta may move a template to another category after review; a utility template with promotional words usually becomes marketing.',
    ],
    checkedAt: CHECKED,
  },
  variables: {
    title: 'Variables and sample values',
    points: [
      'Number the variables {{1}}, {{2}}, … in order, without gaps.',
      'Give every variable a realistic sample value; reviewers read the message with your samples.',
      'Keep enough fixed words around the variables so the message makes sense on its own.',
      'Do not put a phone number, a link or a full sentence into a single variable.',
    ],
    checkedAt: CHECKED,
  },
  media: {
    title: 'Header images, videos and documents',
    points: [
      'Upload a sample file that shows the kind of media you will send: JPEG or PNG images up to 5 MB, MP4 videos up to 16 MB, PDF documents up to 100 MB.',
      'The file sent with each campaign can be different from the sample, as long as it has the same type.',
      'Media from a web address must be a public https link that opens without signing in.',
    ],
    checkedAt: CHECKED,
  },
  buttons: {
    title: 'Buttons',
    points: [
      'Quick replies let the customer answer in one tap; keep each text short and clear.',
      'A website button can end with one variable, for example an order number at the end of the link.',
      'Use a phone number in international format, such as +971…',
      'Button texts cannot be the same, and cannot ask the customer for money outside WhatsApp\'s rules.',
    ],
    checkedAt: CHECKED,
  },
  carousel: {
    title: 'Carousel cards',
    points: [
      'A carousel is a marketing template with 2 to 10 cards; every card has an image or a video of the same kind.',
      'Give every card a text (up to 160 characters) or none of them.',
      'Every card has the same buttons in the same order; their texts and links can differ.',
      'Card files can be changed for each campaign without a new review.',
    ],
    checkedAt: CHECKED,
  },
  offer: {
    title: 'Limited-time offers',
    points: [
      'An offer is a marketing template with a short heading (up to 16 characters), the message and one website button.',
      'The copy-code button is added for you; each campaign gives every recipient their own code.',
      'Turn on the end time to show a countdown; nothing is sent after the offer ends.',
      'An offer template has no footer.',
    ],
    checkedAt: CHECKED,
  },
  authentication: {
    title: 'One-time codes',
    points: [
      'Meta writes the text: "<code> is your verification code", with an optional security note and code validity.',
      'Choose a copy-code button, or one-tap autofill for your Android apps (package name and signature hash).',
      'Send codes through the API; the code is never stored or shown in the dashboard.',
      'A short time-to-live (for example 5 minutes) stops late codes from arriving.',
    ],
    checkedAt: CHECKED,
  },
};

/** Common reasons Meta rejects a template, with how to avoid each. */
export const REJECTION_REASONS: readonly GuidelineEntry[] = [
  { title: 'Variables without context', points: ['The message starts or ends with a variable, or has too many variables for its length. Add fixed words around them.'], checkedAt: CHECKED },
  { title: 'Missing or misleading samples', points: ['Sample values are empty, placeholder text or do not match what you will send. Use realistic examples.'], checkedAt: CHECKED },
  { title: 'Wrong category', points: ['Promotional words in a utility template. Move the promotion to a marketing template.'], checkedAt: CHECKED },
  { title: 'Unclear or threatening wording', points: ['Messages that pressure or threaten the customer, or hide who is writing, are refused. Write plainly and name your business.'], checkedAt: CHECKED },
  { title: 'Forbidden content', points: ['Content against WhatsApp\'s Commerce and Business Policies (for example some regulated products) is refused whatever the wording.'], checkedAt: CHECKED },
  { title: 'Duplicate of an existing template', points: ['A template with the same text as another one of yours. Change the wording, or reuse the existing template.'], checkedAt: CHECKED },
];
