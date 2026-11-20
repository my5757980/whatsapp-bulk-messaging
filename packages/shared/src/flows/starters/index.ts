import { FlowGraphSchema, type FlowGraph } from '../graph.js';

// Starter flows written by us (003 T080, FR-037, constitution Principle II: our own texts). A new flow
// can start from one of them as its draft; nothing is published until the member publishes it. The
// texts mark what to change ("Edit this text…") so nobody publishes placeholder details.

export interface StarterAttribute {
  key: string;
  label: string;
  type: 'TEXT' | 'NUMBER' | 'DATE';
}

export interface FlowStarter {
  key: string;
  name: string;
  description: string;
  /** Contact attributes the starter saves answers to; the editor offers to create missing ones. */
  attributes: StarterAttribute[];
  graph: FlowGraph;
}

const at = (column: number, row = 0) => ({ x: column * 320, y: row * 220 });
const keyword = (...phrases: string[]) => [{ id: 'keyword-1', kind: 'KEYWORD', match: 'CONTAINS', phrases, canInterrupt: false }];

const RAW: Array<Omit<FlowStarter, 'graph'> & { graph: unknown }> = [
  {
    key: 'faq_menu',
    name: 'FAQ menu',
    description: 'A list of common topics (hours, location, prices) with a way to reach your team.',
    attributes: [],
    graph: {
      version: 1,
      start: 'menu',
      triggers: keyword('faq', 'questions'),
      steps: [
        {
          id: 'menu',
          type: 'list',
          position: at(0),
          text: 'Hi {first_name}! What would you like to know?',
          fallbacks: { first_name: 'there' },
          buttonLabel: 'See topics',
          sections: [
            {
              title: 'Topics',
              rows: [
                { key: 'hours', title: 'Opening hours', next: 'hours' },
                { key: 'where', title: 'Where to find us', next: 'where' },
                { key: 'prices', title: 'Prices', next: 'prices' },
                { key: 'person', title: 'Talk to our team', next: 'person' },
              ],
            },
          ],
          answerName: 'topic',
        },
        { id: 'hours', type: 'message', position: at(1, 0), text: 'We are open Monday to Saturday, 9:00 to 18:00. (Edit this text with your own hours.)', next: null },
        { id: 'where', type: 'message', position: at(1, 1), text: 'You can find us at our shop on Main Street. (Edit this text with your own address.)', next: null },
        { id: 'prices', type: 'message', position: at(1, 2), text: 'Our prices start from 100. (Edit this text with your own prices.)', next: null },
        { id: 'person', type: 'handover', position: at(1, 3), note: 'Asked to talk to the team from the FAQ menu.' },
      ],
    },
  },
  {
    key: 'lead_capture',
    name: 'Lead capture',
    description: 'Asks for a name, an email and what the customer is interested in, and saves them to the contact.',
    attributes: [
      { key: 'full_name', label: 'Full name', type: 'TEXT' },
      { key: 'email', label: 'Email', type: 'TEXT' },
      { key: 'interest', label: 'Interest', type: 'TEXT' },
    ],
    graph: {
      version: 1,
      start: 'name',
      triggers: keyword('quote', 'interested'),
      steps: [
        {
          id: 'name',
          type: 'question',
          position: at(0),
          text: 'Thanks for getting in touch! What is your name?',
          answer: { kind: 'text', minLength: 2, maxLength: 80 },
          answerName: 'name',
          saveTo: { attributeKey: 'full_name' },
          retryText: 'Please type your name.',
          next: 'email',
        },
        {
          id: 'email',
          type: 'question',
          position: at(1),
          text: 'Nice to meet you, {answer:name}. Which email address can we reach you at?',
          answer: { kind: 'email' },
          answerName: 'email',
          saveTo: { attributeKey: 'email' },
          retryText: 'That does not look like an email address. Please try again.',
          next: 'interest',
        },
        {
          id: 'interest',
          type: 'buttons',
          position: at(2),
          text: 'What are you interested in?',
          buttons: [
            { key: 'product', title: 'A product', next: 'thanks' },
            { key: 'service', title: 'A service', next: 'thanks' },
            { key: 'other', title: 'Something else', next: 'thanks' },
          ],
          answerName: 'interest',
          saveTo: { attributeKey: 'interest' },
        },
        { id: 'thanks', type: 'message', position: at(3), text: 'Thank you, {answer:name}! Someone from our team will get back to you within one working day.', next: null },
      ],
    },
  },
  {
    key: 'appointment_request',
    name: 'Appointment request',
    description: 'Collects a preferred day and time of day, then hands the chat to your team to confirm.',
    attributes: [
      { key: 'appointment_date', label: 'Appointment date', type: 'DATE' },
      { key: 'appointment_slot', label: 'Appointment time of day', type: 'TEXT' },
    ],
    graph: {
      version: 1,
      start: 'day',
      triggers: keyword('appointment', 'book a visit'),
      steps: [
        {
          id: 'day',
          type: 'question',
          position: at(0),
          text: 'Which day would suit you? You can write a date such as 25/12.',
          answer: { kind: 'date', earliest: 'tomorrow' },
          answerName: 'day',
          saveTo: { attributeKey: 'appointment_date' },
          retryText: 'Please send a date from tomorrow onwards, for example 25/12.',
          next: 'slot',
        },
        {
          id: 'slot',
          type: 'buttons',
          position: at(1),
          text: 'Which time of day works best for you?',
          buttons: [
            { key: 'morning', title: 'Morning', next: 'noted' },
            { key: 'afternoon', title: 'Afternoon', next: 'noted' },
            { key: 'evening', title: 'Evening', next: 'noted' },
          ],
          answerName: 'slot',
          saveTo: { attributeKey: 'appointment_slot' },
        },
        { id: 'noted', type: 'message', position: at(2), text: 'Thanks! We noted {answer:day}, in the {answer:slot}. A teammate will confirm the exact time with you.', next: 'team' },
        { id: 'team', type: 'handover', position: at(3), note: 'Appointment request: please confirm the time with the customer.' },
      ],
    },
  },
  {
    key: 'order_status',
    name: 'Order status lookup',
    description: 'Asks for an order number and looks it up in your own system through an API call.',
    attributes: [],
    graph: {
      version: 1,
      start: 'ask',
      triggers: keyword('order status', 'where is my order'),
      steps: [
        {
          id: 'ask',
          type: 'question',
          position: at(0),
          text: 'Please send your order number.',
          answer: { kind: 'text', minLength: 3, maxLength: 40 },
          answerName: 'order',
          retryText: 'Please send the order number from your confirmation message.',
          next: 'lookup',
        },
        {
          id: 'lookup',
          type: 'api',
          position: at(1),
          method: 'GET',
          url: 'https://api.example.com/orders/{answer:order}',
          timeoutSeconds: 5,
          map: [{ path: 'status', answerName: 'status' }],
          success: 'found',
          failed: 'unknown',
        },
        { id: 'found', type: 'message', position: at(2, 0), text: 'Order {answer:order} is currently: {answer:status}.', fallbacks: { 'answer:status': 'being processed' }, next: null },
        { id: 'unknown', type: 'message', position: at(2, 1), text: 'We could not check order {answer:order} right now. A teammate will look into it.', next: 'team' },
        { id: 'team', type: 'handover', position: at(3, 1), note: 'The order status lookup failed; please check the order.' },
      ],
    },
  },
  {
    key: 'feedback_rating',
    name: 'Feedback rating',
    description: 'Asks how the experience was and, when it was not good, what to improve.',
    attributes: [
      { key: 'feedback_rating', label: 'Feedback rating', type: 'TEXT' },
      { key: 'feedback_comment', label: 'Feedback comment', type: 'TEXT' },
    ],
    graph: {
      version: 1,
      start: 'rate',
      triggers: keyword('feedback', 'review'),
      steps: [
        {
          id: 'rate',
          type: 'buttons',
          position: at(0),
          text: 'How was your experience with us?',
          buttons: [
            { key: 'great', title: 'Great', next: 'thanks' },
            { key: 'okay', title: 'Okay', next: 'thanks' },
            { key: 'poor', title: 'Not good', next: 'why' },
          ],
          answerName: 'rating',
          saveTo: { attributeKey: 'feedback_rating' },
        },
        {
          id: 'why',
          type: 'question',
          position: at(1, 1),
          text: 'Sorry to hear that. What could we do better?',
          answer: { kind: 'text', maxLength: 500 },
          answerName: 'comment',
          saveTo: { attributeKey: 'feedback_comment' },
          retryText: 'Please write a few words about what went wrong.',
          next: 'sorry',
        },
        { id: 'sorry', type: 'message', position: at(2, 1), text: 'Thank you for telling us. We will use your feedback to improve.', next: null },
        { id: 'thanks', type: 'message', position: at(1, 0), text: 'Thank you for your feedback!', next: null },
      ],
    },
  },
  {
    key: 'business_hours',
    name: 'Business hours reply',
    description: 'Answers differently inside and outside your working hours from live chat settings.',
    attributes: [],
    graph: {
      version: 1,
      start: 'open',
      triggers: keyword('opening hours', 'are you open'),
      steps: [
        { id: 'open', type: 'condition', position: at(0), rules: [{ subject: { kind: 'workingHours' }, op: 'inside' }], yes: 'now', no: 'later' },
        { id: 'now', type: 'message', position: at(1, 0), text: 'We are open right now. A teammate will reply to you shortly.', next: null },
        { id: 'later', type: 'message', position: at(1, 1), text: 'We are closed at the moment. We will reply as soon as we open again.', next: null },
      ],
    },
  },
];

/** The starter flows, with graphs checked and filled in by the graph schema. */
export const FLOW_STARTERS: readonly FlowStarter[] = RAW.map((starter) => ({ ...starter, graph: FlowGraphSchema.parse(starter.graph) }));

export function starterByKey(key: string): FlowStarter | undefined {
  return FLOW_STARTERS.find((s) => s.key === key);
}
