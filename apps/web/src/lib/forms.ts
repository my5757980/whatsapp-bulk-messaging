import type { FormCategory, FormFieldType, FormModel, FormProblem } from '@wbm/shared';

// WhatsApp Forms types, query keys and labels (feature 008, T021; contracts/commerce-api.openapi.yaml).

export interface FormVersion {
  id: string;
  number: number;
  status: 'PUBLISHED' | 'FAILED' | 'DEPRECATED';
  accounts?: Array<{ wabaId: string; status: string }>;
  publishedAt: string;
}

export interface FormSummary {
  id: string;
  name: string;
  category: FormCategory;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  changedSincePublish: boolean;
  currentVersion: number | null;
  answers: number;
}

export interface FormDetail extends FormSummary {
  draft: FormModel;
  mapping: Array<{ fieldKey: string; attributeKey: string }>;
  tagIds: string[];
  versions: FormVersion[];
}

export interface FormAnswer {
  id: string;
  versionNumber: number;
  contactId: string | null;
  contactName: string | null;
  phone: string | null;
  source: 'INBOX' | 'FLOW' | 'TEMPLATE' | 'CAMPAIGN';
  answers: Record<string, unknown>;
  problems: Array<{ fieldKey: string; reason: string }>;
  submittedAt: string;
}

export type { FormProblem };

export const formsKeys = {
  list: (status?: string) => ['forms', status ?? 'all'] as const,
  form: (id: string) => ['forms', id] as const,
  answers: (id: string, page: number) => ['forms', id, 'answers', page] as const,
};

export const FORM_CATEGORY_LABEL: Record<FormCategory, string> = {
  SIGN_UP: 'Sign up',
  APPOINTMENT_BOOKING: 'Booking',
  LEAD_GENERATION: 'Lead capture',
  CONTACT_US: 'Contact us',
  CUSTOMER_SUPPORT: 'Support',
  SURVEY: 'Survey',
  OTHER: 'Other',
};

export const FORM_FIELD_LABEL: Record<FormFieldType, string> = {
  shortText: 'Short text',
  longText: 'Long text',
  email: 'Email',
  phone: 'Phone',
  number: 'Number',
  singleChoice: 'One choice',
  multipleChoice: 'Several choices',
  dropdown: 'Dropdown',
  date: 'Date',
  optIn: 'Opt-in checkbox',
};
