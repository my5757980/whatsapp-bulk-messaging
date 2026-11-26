import { describe, expect, it } from 'vitest';
import { FORM_LIMITS, FormModelSchema, formChecks, formFields, type FormModel } from './forms.js';

// T012 (feature 008, research R12): our form model and the checks run before publishing.
const model = (screens: FormModel['screens']): FormModel => FormModelSchema.parse({ screens });
const good = model([
  {
    title: 'Your details',
    button: 'Continue',
    fields: [
      { key: 'name', type: 'shortText', label: 'Name', required: true },
      { key: 'email', type: 'email', label: 'Email', required: true },
    ],
  },
  {
    title: 'Your visit',
    button: 'Submit',
    fields: [
      { key: 'visit_date', type: 'date', label: 'Date', required: true },
      { key: 'branch', type: 'singleChoice', label: 'Branch', required: true, options: [{ id: 'dxb', title: 'Dubai' }, { id: 'shj', title: 'Sharjah' }] },
      { key: 'news', type: 'optIn', label: 'Send me offers on WhatsApp', required: false },
    ],
  },
]);

describe('FormModelSchema', () => {
  it('accepts screens of typed fields and defaults required to false', () => {
    const parsed = FormModelSchema.parse({ screens: [{ title: 'A', button: 'Submit', fields: [{ key: 'note', type: 'longText', label: 'Note' }] }] });
    expect(parsed.screens[0]?.fields[0]?.required).toBe(false);
    expect(formFields(good).map((f) => [f.screen, f.field.key])).toEqual([[0, 'name'], [0, 'email'], [1, 'visit_date'], [1, 'branch'], [1, 'news']]);
  });

  it('refuses bad keys, the reserved flow_token key, unknown types and more than 10 screens', () => {
    const one = (field: Record<string, unknown>) => FormModelSchema.safeParse({ screens: [{ title: 'A', button: 'B', fields: [field] }] }).success;
    expect(one({ key: 'Name', type: 'shortText', label: 'Name' })).toBe(false);
    expect(one({ key: '1name', type: 'shortText', label: 'Name' })).toBe(false);
    expect(one({ key: 'flow_token', type: 'shortText', label: 'Token' })).toBe(false);
    expect(one({ key: 'name', type: 'signature', label: 'Name' })).toBe(false);
    const screens = Array.from({ length: 11 }, () => ({ title: 'A', button: 'B', fields: [] }));
    expect(FormModelSchema.safeParse({ screens }).success).toBe(false);
    expect(FormModelSchema.safeParse({ screens: [] }).success).toBe(false);
  });
});

describe('formChecks', () => {
  it('finds nothing wrong with a good form', () => {
    expect(formChecks(good)).toEqual([]);
  });

  it('needs at least one field', () => {
    expect(formChecks(model([{ title: 'Hello', text: 'Just text', button: 'Submit', fields: [] }]))).toEqual([{ screen: null, fieldKey: null, message: 'Add at least one field' }]);
  });

  it('finds keys used twice across screens', () => {
    const twice = model([
      { title: 'A', button: 'Next', fields: [{ key: 'name', type: 'shortText', label: 'Name' }] },
      { title: 'B', button: 'Submit', fields: [{ key: 'name', type: 'shortText', label: 'Name again' }] },
    ]);
    expect(formChecks(twice)).toEqual([{ screen: 1, fieldKey: 'name', message: 'The key "name" is used twice' }]);
  });

  it("checks texts against Meta's limits for each component (verify)", () => {
    const long = (n: number) => 'x'.repeat(n);
    const problems = formChecks(model([
      {
        title: long(FORM_LIMITS.screenTitle + 1),
        button: long(FORM_LIMITS.button + 1),
        fields: [
          { key: 'a', type: 'shortText', label: long(FORM_LIMITS.inputLabel + 1) },
          { key: 'b', type: 'singleChoice', label: long(FORM_LIMITS.choiceLabel + 1), options: [{ id: 'x', title: long(FORM_LIMITS.optionTitle + 1) }] },
          { key: 'c', type: 'date', label: long(FORM_LIMITS.dateLabel + 1) },
          { key: 'd', type: 'optIn', label: long(FORM_LIMITS.optInLabel + 1) },
          { key: 'e', type: 'email', label: 'Email', helper: long(FORM_LIMITS.helper + 1) },
        ],
      },
    ]));
    expect(problems.map((p) => [p.screen, p.fieldKey])).toEqual([[0, null], [0, null], [0, 'a'], [0, 'b'], [0, 'b'], [0, 'c'], [0, 'd'], [0, 'e']]);
    expect(problems[0]?.message).toMatch(/title/i);
    expect(problems[1]?.message).toMatch(/button/i);
  });

  it('needs options for choices, within the limits, with distinct ids', () => {
    const choice = (type: string, count: number, ids?: string[]) => model([{ title: 'A', button: 'Submit', fields: [{ key: 'pick', type, label: 'Pick', options: (ids ?? Array.from({ length: count }, (_, i) => `o${i}`)).map((id) => ({ id, title: id })) } as never] }]);
    expect(formChecks(choice('singleChoice', 0))[0]?.message).toMatch(/option/);
    expect(formChecks(choice('multipleChoice', FORM_LIMITS.options))).toEqual([]);
    expect(formChecks(choice('multipleChoice', FORM_LIMITS.options + 1))[0]?.message).toMatch(String(FORM_LIMITS.options));
    expect(formChecks(choice('dropdown', FORM_LIMITS.dropdownOptions))).toEqual([]);
    expect(formChecks(choice('singleChoice', 2, ['a', 'a']))[0]?.message).toMatch(/twice/);
  });
});
