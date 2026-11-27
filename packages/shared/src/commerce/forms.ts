// WhatsApp Forms (feature 008, research R12): our form model and the checks run before publishing.
// The schema accepts drafts loosely; formChecks applies Meta's limits. Pure.
import { z } from 'zod';

export const FORM_FIELD_TYPES = ['shortText', 'longText', 'email', 'phone', 'number', 'singleChoice', 'multipleChoice', 'dropdown', 'date', 'optIn'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];
export const FORM_CHOICE_TYPES: readonly FormFieldType[] = ['singleChoice', 'multipleChoice', 'dropdown'];
export const FORM_CATEGORIES = ['SIGN_UP', 'APPOINTMENT_BOOKING', 'LEAD_GENERATION', 'CONTACT_US', 'CUSTOMER_SUPPORT', 'SURVEY', 'OTHER'] as const;
export type FormCategory = (typeof FORM_CATEGORIES)[number];

/** Limits from Meta's Flow JSON component reference (verify each against the live page, T083). */
export const FORM_LIMITS = {
  screens: 10,
  fieldsPerScreen: 10,
  fieldsTotal: 50,
  screenTitle: 30,
  heading: 80,
  text: 4096,
  button: 35,
  inputLabel: 20,
  choiceLabel: 30,
  dateLabel: 40,
  optInLabel: 120,
  helper: 80,
  options: 20,
  dropdownOptions: 200,
  optionTitle: 30,
} as const;

/** Reserved: Meta puts the flow token in the answer next to the fields. */
const RESERVED_KEYS = new Set(['flow_token']);
export const FormFieldKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'start with a letter; use lower-case letters, digits and _')
  .refine((key) => !RESERVED_KEYS.has(key), 'this key is reserved');

const OptionSchema = z.strictObject({ id: z.string().regex(/^[a-z0-9_]{1,30}$/, 'use 1–30 lower-case letters, digits or _'), title: z.string().min(1).max(200) });

export const FormFieldSchema = z.strictObject({
  key: FormFieldKeySchema,
  type: z.enum(FORM_FIELD_TYPES),
  label: z.string().min(1).max(300),
  helper: z.string().max(300).optional(),
  required: z.boolean().default(false),
  options: z.array(OptionSchema).max(FORM_LIMITS.dropdownOptions + 50).optional(),
});

export const FormScreenSchema = z.strictObject({
  title: z.string().min(1).max(200),
  heading: z.string().max(300).optional(),
  text: z.string().max(FORM_LIMITS.text).optional(),
  fields: z.array(FormFieldSchema).max(FORM_LIMITS.fieldsPerScreen).default([]),
  button: z.string().min(1).max(200),
});

export const FormModelSchema = z.strictObject({ screens: z.array(FormScreenSchema).min(1).max(FORM_LIMITS.screens) });

export type FormField = z.infer<typeof FormFieldSchema>;
export type FormScreen = z.infer<typeof FormScreenSchema>;
export type FormModel = z.infer<typeof FormModelSchema>;

export interface FormProblem {
  screen: number | null;
  fieldKey: string | null;
  message: string;
}

/** Every field with its screen index, in order. */
export function formFields(model: FormModel): Array<{ screen: number; field: FormField }> {
  return model.screens.flatMap((screen, index) => screen.fields.map((field) => ({ screen: index, field })));
}

const len = (value: string | undefined) => [...(value ?? '')].length;

function labelLimit(type: FormFieldType): number {
  if (FORM_CHOICE_TYPES.includes(type)) return FORM_LIMITS.choiceLabel;
  if (type === 'date') return FORM_LIMITS.dateLabel;
  if (type === 'optIn') return FORM_LIMITS.optInLabel;
  return FORM_LIMITS.inputLabel;
}

/** Problems that stop publishing (FR-031); an empty list means the form is ready. */
export function formChecks(model: FormModel): FormProblem[] {
  const problems: FormProblem[] = [];
  const fields = formFields(model);
  if (fields.length === 0) return [{ screen: null, fieldKey: null, message: 'Add at least one field' }];
  if (fields.length > FORM_LIMITS.fieldsTotal) problems.push({ screen: null, fieldKey: null, message: `A form has at most ${FORM_LIMITS.fieldsTotal} fields` });

  const seen = new Set<string>();
  model.screens.forEach((screen, index) => {
    if (len(screen.title) > FORM_LIMITS.screenTitle) problems.push({ screen: index, fieldKey: null, message: `The screen title has at most ${FORM_LIMITS.screenTitle} characters` });
    if (len(screen.button) > FORM_LIMITS.button) problems.push({ screen: index, fieldKey: null, message: `The button has at most ${FORM_LIMITS.button} characters` });
    if (len(screen.heading) > FORM_LIMITS.heading) problems.push({ screen: index, fieldKey: null, message: `The heading has at most ${FORM_LIMITS.heading} characters` });
    for (const field of screen.fields) {
      const at = (message: string) => problems.push({ screen: index, fieldKey: field.key, message });
      if (seen.has(field.key)) at(`The key "${field.key}" is used twice`);
      seen.add(field.key);
      const limit = labelLimit(field.type);
      if (len(field.label) > limit) at(`The label has at most ${limit} characters`);
      if (len(field.helper) > FORM_LIMITS.helper) at(`The help text has at most ${FORM_LIMITS.helper} characters`);
      if (FORM_CHOICE_TYPES.includes(field.type)) {
        const options = field.options ?? [];
        const max = field.type === 'dropdown' ? FORM_LIMITS.dropdownOptions : FORM_LIMITS.options;
        if (options.length === 0) at('Add at least one option');
        else if (options.length > max) at(`At most ${max} options`);
        if (new Set(options.map((o) => o.id)).size !== options.length) at('An option id is used twice');
        if (options.some((o) => len(o.title) > FORM_LIMITS.optionTitle)) at(`Options have at most ${FORM_LIMITS.optionTitle} characters`);
      }
    }
  });
  return problems;
}
