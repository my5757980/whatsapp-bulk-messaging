import type { TemplateButtonDraft, TemplateDraft } from '../template-rules.js';

// Feature 009 (research R13, FR-024): the sample template library. Every text was written for this
// project in our own words. A sample is copied into a DRAFT for an account; media samples still need
// a file before they are submitted. Unit-tested in samples.test.ts (coverage, Meta's rules, unique names).

export const SAMPLE_INDUSTRIES = ['RETAIL', 'FOOD', 'HEALTH', 'EDUCATION', 'REAL_ESTATE', 'TRAVEL', 'BEAUTY', 'AUTOMOTIVE', 'FINANCE', 'SERVICES'] as const;
export const SAMPLE_PURPOSES = ['WELCOME', 'ORDER_UPDATE', 'APPOINTMENT_REMINDER', 'PAYMENT_REMINDER', 'OFFER', 'FEEDBACK', 'ONE_TIME_CODE'] as const;
export const SAMPLE_TYPES = ['TEXT', 'MEDIA', 'CAROUSEL', 'OFFER', 'AUTHENTICATION'] as const;

export type SampleIndustry = (typeof SAMPLE_INDUSTRIES)[number];
export type SamplePurpose = (typeof SAMPLE_PURPOSES)[number];
export type SampleType = (typeof SAMPLE_TYPES)[number];

export interface TemplateSample {
  id: string;
  version: number;
  industry: SampleIndustry;
  purpose: SamplePurpose;
  type: SampleType;
  language: 'en' | 'ar';
  category: TemplateDraft['category'];
  /** The suggested template name (changeable when copied). */
  name: string;
  /** A TemplateDraft without an account or media. */
  draft: Omit<TemplateDraft, 'wabaId'>;
}

type Draft = Omit<TemplateDraft, 'wabaId' | 'name' | 'language' | 'category'>;

const quick = (...texts: string[]): TemplateButtonDraft[] => texts.map((text) => ({ type: 'QUICK_REPLY', text }));
const link = (text: string, url: string, urlExample?: string): TemplateButtonDraft => ({ type: 'URL', text, url, ...(urlExample ? { urlExample } : {}) });
const call = (text: string, phoneNumber: string): TemplateButtonDraft => ({ type: 'PHONE_NUMBER', text, phoneNumber });
const body = (text: string, ...examples: string[]) => ({ text, examples });
const code = (codeExpiryMinutes: number): Draft => ({
  kind: 'AUTHENTICATION',
  body: { text: '' },
  auth: { securityNote: true, codeExpiryMinutes, button: 'COPY_CODE', buttonText: 'Copy code' },
});

function sample(id: string, industry: SampleIndustry, purpose: SamplePurpose, type: SampleType, category: TemplateDraft['category'], draft: Draft, language: 'en' | 'ar' = 'en'): TemplateSample {
  const name = id.replace(/-/g, '_');
  return { id, version: 1, industry, purpose, type, language, category, name, draft: { name, language: language === 'ar' ? 'ar' : 'en_US', category, ...draft } };
}

/** A three-card carousel with one quick reply per card. */
function carousel(text: string, example: string, cards: Array<[string, string]>, button: string): Draft {
  return {
    kind: 'CAROUSEL',
    body: body(text, example),
    cards: cards.map(([cardText, cardExample]) => ({ mediaFormat: 'IMAGE', sampleMediaAssetId: null, bodyText: cardText, bodyExamples: [cardExample], buttons: quick(button) })),
  };
}

/** A limited-time offer with its heading, example code and one website button. */
function offer(text: string, example: string, offerText: string, codeExample: string, url: string): Draft {
  return { kind: 'LIMITED_TIME_OFFER', header: { format: 'IMAGE' }, body: body(text, example), buttons: [link('Shop now', url)], offer: { offerText, showsEndTime: true, codeExample } };
}

export const TEMPLATE_SAMPLES: readonly TemplateSample[] = [
  // Retail
  sample('retail-welcome', 'RETAIL', 'WELCOME', 'TEXT', 'MARKETING', { body: body('Hi {{1}}, thanks for joining our shoppers list! Reply with what you are looking for and we will send you our newest picks.', 'Sara'), footer: 'Reply STOP to unsubscribe', buttons: quick('Show new arrivals', 'Stop messages') }),
  sample('retail-order-shipped', 'RETAIL', 'ORDER_UPDATE', 'TEXT', 'UTILITY', { body: body('Good news {{1}}: your order {{2}} has left our warehouse and should reach you within two working days.', 'Sara', 'A-1042'), buttons: [link('Track order', 'https://shop.example.com/track/{{1}}', 'A-1042')] }),
  sample('retail-payment-due', 'RETAIL', 'PAYMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, a friendly reminder that the balance of {{2}} for your order is due on {{3}}.', 'Sara', 'AED 120', '30 November'), buttons: [link('Pay now', 'https://shop.example.com/pay/{{1}}', 'A-1042')] }),
  sample('retail-new-arrivals', 'RETAIL', 'OFFER', 'CAROUSEL', 'MARKETING', carousel('Hi {{1}}, swipe through this week\'s new arrivals picked for you.', 'Sara', [['Linen shirt, now {{1}}', 'AED 99'], ['Canvas sneakers, now {{1}}', 'AED 149'], ['Leather belt, now {{1}}', 'AED 59']], 'Tell me more')),
  sample('retail-weekend-deal', 'RETAIL', 'OFFER', 'OFFER', 'MARKETING', offer('Hi {{1}}, take 20% off everything in store and online until Sunday night.', 'Sara', 'Weekend deal', 'WKND20', 'https://shop.example.com/offers')),
  sample('retail-feedback', 'RETAIL', 'FEEDBACK', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, how was your recent purchase with us? Your answer helps us improve.', 'Sara'), buttons: quick('Loved it', 'It was okay', 'Not happy') }),

  // Food
  sample('food-welcome', 'FOOD', 'WELCOME', 'MEDIA', 'MARKETING', { header: { format: 'IMAGE' }, body: body('Welcome to the table, {{1}}! Here is our menu for this week. Reply with a dish name to order.', 'Omar'), buttons: quick('See the menu', 'Order now') }),
  sample('food-order-update', 'FOOD', 'ORDER_UPDATE', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, your order {{2}} is being prepared and will be with you in about {{3}} minutes.', 'Omar', '#3381', '25'), buttons: quick('Where is my order?') }),
  sample('food-table-reminder', 'FOOD', 'APPOINTMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, this is a reminder of your table for {{2}} people tonight at {{3}}.', 'Omar', '4', '8:00 pm'), buttons: quick('Confirm', 'Change time') }),
  sample('food-chef-specials', 'FOOD', 'OFFER', 'CAROUSEL', 'MARKETING', carousel('Hungry, {{1}}? These are tonight\'s chef specials.', 'Omar', [['Grilled sea bream with herbs, {{1}}', 'AED 65'], ['Slow-cooked lamb with rice, {{1}}', 'AED 72'], ['Saffron rice pudding, {{1}}', 'AED 25']], 'Order this')),
  sample('food-lunch-offer', 'FOOD', 'OFFER', 'OFFER', 'MARKETING', offer('Hi {{1}}, enjoy two lunch boxes for the price of one today only.', 'Omar', 'Lunch for two', 'LUNCH2', 'https://food.example.com/order')),
  sample('food-feedback', 'FOOD', 'FEEDBACK', 'TEXT', 'UTILITY', { body: body('Thanks for dining with us, {{1}}. How would you rate your meal today?', 'Omar'), buttons: quick('Excellent', 'Good', 'Could be better') }),

  // Health
  sample('health-welcome', 'HEALTH', 'WELCOME', 'TEXT', 'MARKETING', { body: body('Hello {{1}}, welcome to our clinic\'s messages. We will send your appointment reminders and health tips here.', 'Layla'), footer: 'Reply STOP to unsubscribe' }),
  sample('health-appointment-reminder', 'HEALTH', 'APPOINTMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, your appointment with {{2}} is on {{3}}. Please arrive 10 minutes early.', 'Layla', 'Dr. Hana', 'Monday at 10:30'), buttons: quick('Confirm', 'Reschedule') }),
  sample('health-results-ready', 'HEALTH', 'ORDER_UPDATE', 'MEDIA', 'UTILITY', { header: { format: 'DOCUMENT' }, body: body('Hi {{1}}, your test results from {{2}} are attached. Your doctor will call you if anything needs follow-up.', 'Layla', '24 November') }),
  sample('health-bill-reminder', 'HEALTH', 'PAYMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, the amount of {{2}} for your visit on {{3}} is still open.', 'Layla', 'AED 250', '20 November'), buttons: [call('Call billing', '+15550100001')] }),
  sample('health-login-code', 'HEALTH', 'ONE_TIME_CODE', 'AUTHENTICATION', 'AUTHENTICATION', code(10)),
  sample('health-feedback', 'HEALTH', 'FEEDBACK', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, how was your visit today? Your feedback helps our team care for you better.', 'Layla'), buttons: quick('Very good', 'Okay', 'Not good') }),

  // Education
  sample('education-welcome', 'EDUCATION', 'WELCOME', 'TEXT', 'MARKETING', { body: body('Welcome {{1}}! You will get class updates and course news from us here.', 'Yusuf'), buttons: quick('Course list', 'Talk to us') }),
  sample('education-class-reminder', 'EDUCATION', 'APPOINTMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, your {{2}} class starts tomorrow at {{3}} in room {{4}}.', 'Yusuf', 'English B2', '6:00 pm', '12') }),
  sample('education-fee-reminder', 'EDUCATION', 'PAYMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Dear {{1}}, the term fee of {{2}} is due on {{3}}. Thank you for paying on time.', 'Yusuf', 'AED 3,200', '1 December'), buttons: [link('Pay the fee', 'https://school.example.com/fees')] }),
  sample('education-certificate', 'EDUCATION', 'ORDER_UPDATE', 'MEDIA', 'UTILITY', { header: { format: 'DOCUMENT' }, body: body('Congratulations {{1}}! Your certificate for {{2}} is attached.', 'Yusuf', 'Web Design Basics') }),
  sample('education-portal-code', 'EDUCATION', 'ONE_TIME_CODE', 'AUTHENTICATION', 'AUTHENTICATION', code(5)),
  sample('education-feedback', 'EDUCATION', 'FEEDBACK', 'TEXT', 'MARKETING', { body: body('Hi {{1}}, what did you think of the {{2}} course? Tell us in one tap.', 'Yusuf', 'Excel Skills'), buttons: quick('Great course', 'It was fine', 'Needs work') }),

  // Real estate
  sample('real-estate-welcome', 'REAL_ESTATE', 'WELCOME', 'TEXT', 'MARKETING', { body: body('Hi {{1}}, thanks for your interest in our homes. Tell us your area and budget and we will send matching listings.', 'Mariam'), buttons: quick('Apartments', 'Villas') }),
  sample('real-estate-listings', 'REAL_ESTATE', 'OFFER', 'CAROUSEL', 'MARKETING', carousel('Hi {{1}}, here are three new homes that match your search.', 'Mariam', [['Two-bedroom flat near the park, {{1}} a year', 'AED 85,000'], ['Three-bedroom townhouse with garden, {{1}} a year', 'AED 140,000'], ['Studio close to the metro, {{1}} a year', 'AED 45,000']], 'Book a viewing')),
  sample('real-estate-viewing-reminder', 'REAL_ESTATE', 'APPOINTMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, a reminder of your viewing at {{2}} on {{3}}. Your agent will meet you at the entrance.', 'Mariam', 'Palm Court, unit 14', 'Saturday at 11:00'), buttons: quick('Confirm', 'Change time') }),
  sample('real-estate-rent-due', 'REAL_ESTATE', 'PAYMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Dear {{1}}, the rent of {{2}} for {{3}} is due in five days.', 'Mariam', 'AED 7,000', 'unit 14'), buttons: [link('Pay rent', 'https://homes.example.com/rent')] }),
  sample('real-estate-contract', 'REAL_ESTATE', 'ORDER_UPDATE', 'MEDIA', 'UTILITY', { header: { format: 'DOCUMENT' }, body: body('Hi {{1}}, your tenancy contract for {{2}} is attached for your review.', 'Mariam', 'unit 14') }),
  sample('real-estate-feedback', 'REAL_ESTATE', 'FEEDBACK', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, how was your viewing with our agent today?', 'Mariam'), buttons: quick('Very helpful', 'Okay', 'Not helpful') }),

  // Travel
  sample('travel-welcome', 'TRAVEL', 'WELCOME', 'TEXT', 'MARKETING', { body: body('Hi {{1}}, welcome aboard! We will share trip ideas and booking updates with you here.', 'Daniel'), buttons: quick('Trip ideas', 'My bookings') }),
  sample('travel-booking-confirmed', 'TRAVEL', 'ORDER_UPDATE', 'MEDIA', 'UTILITY', { header: { format: 'DOCUMENT' }, body: body('Hi {{1}}, your booking {{2}} is confirmed. Your itinerary is attached.', 'Daniel', 'TR-5531') }),
  sample('travel-checkin-reminder', 'TRAVEL', 'APPOINTMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, online check-in for your trip to {{2}} opens now. Your departure is on {{3}}.', 'Daniel', 'Istanbul', '3 December'), buttons: [link('Check in', 'https://travel.example.com/check-in/{{1}}', 'TR-5531')] }),
  sample('travel-destinations', 'TRAVEL', 'OFFER', 'CAROUSEL', 'MARKETING', carousel('Dreaming of a break, {{1}}? Three trips our travellers love this month.', 'Daniel', [['Four nights by the sea from {{1}}', 'AED 1,890'], ['City weekend with breakfast from {{1}}', 'AED 990'], ['Mountain lodge escape from {{1}}', 'AED 1,450']], 'See details')),
  sample('travel-balance-due', 'TRAVEL', 'PAYMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, the remaining {{2}} for booking {{3}} is due seven days before departure.', 'Daniel', 'AED 1,200', 'TR-5531'), buttons: [link('Pay balance', 'https://travel.example.com/pay')] }),
  sample('travel-feedback', 'TRAVEL', 'FEEDBACK', 'TEXT', 'MARKETING', { body: body('Welcome home, {{1}}! How was your trip to {{2}}?', 'Daniel', 'Istanbul'), buttons: quick('Amazing', 'Good', 'Disappointing') }),

  // Beauty
  sample('beauty-welcome', 'BEAUTY', 'WELCOME', 'MEDIA', 'MARKETING', { header: { format: 'IMAGE' }, body: body('Hi {{1}}, welcome to our salon family! Book your next visit straight from this chat.', 'Noor'), buttons: quick('Book a visit', 'Our services') }),
  sample('beauty-appointment-reminder', 'BEAUTY', 'APPOINTMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, see you {{2}} at {{3}} for your {{4}}.', 'Noor', 'tomorrow', '4:00 pm', 'hair treatment'), buttons: quick('Confirm', 'Reschedule') }),
  sample('beauty-flash-sale', 'BEAUTY', 'OFFER', 'OFFER', 'MARKETING', offer('Hi {{1}}, our skincare range is 30% off for the next 48 hours.', 'Noor', 'Glow week', 'GLOW30', 'https://beauty.example.com/sale')),
  sample('beauty-order-ready', 'BEAUTY', 'ORDER_UPDATE', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, your order {{2}} is ready for pickup at our {{3}} branch.', 'Noor', 'B-778', 'Marina') }),
  sample('beauty-member-code', 'BEAUTY', 'ONE_TIME_CODE', 'AUTHENTICATION', 'AUTHENTICATION', code(10)),
  sample('beauty-feedback', 'BEAUTY', 'FEEDBACK', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, how did you like your visit with {{2}} today?', 'Noor', 'Rania'), buttons: quick('Loved it', 'It was okay', 'Not happy') }),

  // Automotive
  sample('automotive-welcome', 'AUTOMOTIVE', 'WELCOME', 'TEXT', 'MARKETING', { body: body('Hi {{1}}, thanks for choosing our service centre. We will remind you here when your car is due for a check.', 'Khalid'), buttons: quick('Book a service') }),
  sample('automotive-service-reminder', 'AUTOMOTIVE', 'APPOINTMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, your {{2}} is booked in for service on {{3}}. Please bring the service book.', 'Khalid', 'sedan', 'Tuesday at 9:00'), buttons: quick('Confirm', 'Change date') }),
  sample('automotive-car-ready', 'AUTOMOTIVE', 'ORDER_UPDATE', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, your car is ready for collection. The total for today\'s work is {{2}}.', 'Khalid', 'AED 680'), buttons: [call('Call the workshop', '+15550100002')] }),
  sample('automotive-invoice', 'AUTOMOTIVE', 'PAYMENT_REMINDER', 'MEDIA', 'UTILITY', { header: { format: 'DOCUMENT' }, body: body('Hi {{1}}, the invoice for job {{2}} is attached. It is due on {{3}}.', 'Khalid', 'J-2290', '5 December') }),
  sample('automotive-models', 'AUTOMOTIVE', 'OFFER', 'CAROUSEL', 'MARKETING', carousel('Hi {{1}}, test drive one of this month\'s featured cars.', 'Khalid', [['Compact hatchback from {{1}} a month', 'AED 1,199'], ['Family SUV from {{1}} a month', 'AED 1,899'], ['Electric sedan from {{1}} a month', 'AED 2,299']], 'Book a test drive')),
  sample('automotive-feedback', 'AUTOMOTIVE', 'FEEDBACK', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, how satisfied are you with today\'s service?', 'Khalid'), buttons: quick('Very satisfied', 'Satisfied', 'Unsatisfied') }),

  // Finance
  sample('finance-welcome', 'FINANCE', 'WELCOME', 'TEXT', 'MARKETING', { body: body('Hi {{1}}, welcome! You can now get account alerts and product news from us here.', 'Ahmed'), footer: 'Reply STOP to unsubscribe' }),
  sample('finance-login-code', 'FINANCE', 'ONE_TIME_CODE', 'AUTHENTICATION', 'AUTHENTICATION', code(5)),
  sample('finance-payment-due', 'FINANCE', 'PAYMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Dear {{1}}, the payment of {{2}} for your plan is due on {{3}}.', 'Ahmed', 'AED 1,500', '28 November'), buttons: [link('Pay now', 'https://pay.example.com/plan')] }),
  sample('finance-statement', 'FINANCE', 'ORDER_UPDATE', 'MEDIA', 'UTILITY', { header: { format: 'DOCUMENT' }, body: body('Hi {{1}}, your statement for {{2}} is attached.', 'Ahmed', 'November') }),
  sample('finance-advisor-meeting', 'FINANCE', 'APPOINTMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, your meeting with your advisor is on {{2}}. Reply if you need to change it.', 'Ahmed', 'Wednesday at 2:00 pm'), buttons: quick('Confirm', 'Change time') }),
  sample('finance-feedback', 'FINANCE', 'FEEDBACK', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, how easy was it to open your account with us?', 'Ahmed'), buttons: quick('Very easy', 'Okay', 'Difficult') }),

  // Services
  sample('services-welcome', 'SERVICES', 'WELCOME', 'TEXT', 'MARKETING', { body: body('Hi {{1}}, thanks for signing up! Book cleaning, repairs and more right here in the chat.', 'Fatima'), buttons: quick('Book a service', 'Prices') }),
  sample('services-visit-reminder', 'SERVICES', 'APPOINTMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, our technician will visit on {{2}} between {{3}}.', 'Fatima', 'Thursday', '9 and 11 am'), buttons: quick('Confirm', 'Reschedule') }),
  sample('services-job-done', 'SERVICES', 'ORDER_UPDATE', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, job {{2}} is complete. Thank you for letting us help.', 'Fatima', 'S-4410') }),
  sample('services-invoice-due', 'SERVICES', 'PAYMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, invoice {{2}} for {{3}} is due on {{4}}.', 'Fatima', 'S-4410', 'AED 350', '2 December'), buttons: [link('Pay invoice', 'https://services.example.com/pay/{{1}}', 'S-4410')] }),
  sample('services-account-code', 'SERVICES', 'ONE_TIME_CODE', 'AUTHENTICATION', 'AUTHENTICATION', code(10)),
  sample('services-feedback', 'SERVICES', 'FEEDBACK', 'TEXT', 'UTILITY', { body: body('Hi {{1}}, how was the work our team did today?', 'Fatima'), buttons: quick('Excellent', 'Good', 'Poor') }),

  // Arabic
  sample('retail-welcome-ar', 'RETAIL', 'WELCOME', 'TEXT', 'MARKETING', { body: body('مرحباً {{1}}، شكراً لانضمامك إلى قائمة عملائنا! أخبرنا بما تبحث عنه وسنرسل لك أحدث المنتجات.', 'سارة'), buttons: quick('عرض الجديد') }, 'ar'),
  sample('retail-order-shipped-ar', 'RETAIL', 'ORDER_UPDATE', 'TEXT', 'UTILITY', { body: body('مرحباً {{1}}، تم شحن طلبك رقم {{2}} وسيصلك خلال يومي عمل.', 'سارة', 'A-1042') }, 'ar'),
  sample('food-order-update-ar', 'FOOD', 'ORDER_UPDATE', 'TEXT', 'UTILITY', { body: body('مرحباً {{1}}، طلبك رقم {{2}} قيد التحضير وسيصلك خلال {{3}} دقيقة تقريباً.', 'عمر', '3381', '25') }, 'ar'),
  sample('health-appointment-reminder-ar', 'HEALTH', 'APPOINTMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('مرحباً {{1}}، نذكّرك بموعدك مع {{2}} يوم {{3}}. يرجى الحضور قبل الموعد بعشر دقائق.', 'ليلى', 'د. هناء', 'الاثنين الساعة 10:30'), buttons: quick('تأكيد', 'تغيير الموعد') }, 'ar'),
  sample('education-fee-reminder-ar', 'EDUCATION', 'PAYMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('عزيزي {{1}}، رسوم الفصل الدراسي البالغة {{2}} مستحقة بتاريخ {{3}}.', 'يوسف', '3,200 درهم', '1 ديسمبر') }, 'ar'),
  sample('real-estate-viewing-reminder-ar', 'REAL_ESTATE', 'APPOINTMENT_REMINDER', 'TEXT', 'UTILITY', { body: body('مرحباً {{1}}، نذكّرك بموعد المعاينة في {{2}} يوم {{3}}.', 'مريم', 'الوحدة 14', 'السبت الساعة 11:00') }, 'ar'),
  sample('travel-booking-confirmed-ar', 'TRAVEL', 'ORDER_UPDATE', 'TEXT', 'UTILITY', { body: body('مرحباً {{1}}، تم تأكيد حجزك رقم {{2}}. نتمنى لك رحلة سعيدة!', 'دانيال', 'TR-5531') }, 'ar'),
  sample('beauty-weekend-offer-ar', 'BEAUTY', 'OFFER', 'TEXT', 'MARKETING', { body: body('مرحباً {{1}}، خصم 30% على جميع منتجات العناية بالبشرة حتى نهاية الأسبوع.', 'نور'), footer: 'أرسل STOP لإيقاف الرسائل', buttons: [link('تسوقي الآن', 'https://beauty.example.com/sale')] }, 'ar'),
  sample('finance-login-code-ar', 'FINANCE', 'ONE_TIME_CODE', 'AUTHENTICATION', 'AUTHENTICATION', code(5), 'ar'),
  sample('services-feedback-ar', 'SERVICES', 'FEEDBACK', 'TEXT', 'UTILITY', { body: body('مرحباً {{1}}، ما رأيك في الخدمة التي قدمها فريقنا اليوم؟', 'فاطمة'), buttons: quick('ممتازة', 'جيدة', 'ضعيفة') }, 'ar'),
];

/** Samples matching the filters and a search over the name and texts (FR-025). */
export function filterSamples(filters: { industry?: SampleIndustry; purpose?: SamplePurpose; type?: SampleType; language?: 'en' | 'ar'; search?: string }): TemplateSample[] {
  const needle = filters.search?.trim().toLowerCase();
  return TEMPLATE_SAMPLES.filter(
    (s) =>
      (!filters.industry || s.industry === filters.industry) &&
      (!filters.purpose || s.purpose === filters.purpose) &&
      (!filters.type || s.type === filters.type) &&
      (!filters.language || s.language === filters.language) &&
      (!needle || [s.name, s.draft.body.text, ...(s.draft.cards ?? []).map((c) => c.bodyText ?? '')].some((t) => t.toLowerCase().includes(needle))),
  );
}
