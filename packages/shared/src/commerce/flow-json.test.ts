import { describe, expect, it } from 'vitest';
import { FLOW_JSON_VERSION, compileFlowJson, formScreenId } from './flow-json.js';
import { FormModelSchema } from './forms.js';

// T012 (feature 008, research R12): our form model compiled to static Flow JSON 7.3, matching the
// two-screen example of contracts/meta-commerce-graph.md exactly.
describe('compileFlowJson', () => {
  it('produces the contract example', () => {
    const form = FormModelSchema.parse({
      screens: [
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
          ],
        },
      ],
    });
    expect(compileFlowJson(form)).toEqual({
      version: '7.3',
      screens: [
        {
          id: 'S1',
          title: 'Your details',
          layout: {
            type: 'SingleColumnLayout',
            children: [
              { type: 'TextInput', name: 'name', label: 'Name', 'input-type': 'text', required: true },
              { type: 'TextInput', name: 'email', label: 'Email', 'input-type': 'email', required: true },
              { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'S2' }, payload: {} } },
            ],
          },
        },
        {
          id: 'S2',
          title: 'Your visit',
          terminal: true,
          layout: {
            type: 'SingleColumnLayout',
            children: [
              { type: 'DatePicker', name: 'visit_date', label: 'Date', required: true },
              { type: 'RadioButtonsGroup', name: 'branch', label: 'Branch', required: true, 'data-source': [{ id: 'dxb', title: 'Dubai' }, { id: 'shj', title: 'Sharjah' }] },
              {
                type: 'Footer',
                label: 'Submit',
                'on-click-action': {
                  name: 'complete',
                  payload: { name: '${screen.S1.form.name}', email: '${screen.S1.form.email}', visit_date: '${form.visit_date}', branch: '${form.branch}' },
                },
              },
            ],
          },
        },
      ],
    });
  });

  it('maps every field type, texts and helpers to their components', () => {
    const form = FormModelSchema.parse({
      screens: [
        {
          title: 'All',
          heading: 'Tell us more',
          text: 'It takes a minute.',
          button: 'Send',
          fields: [
            { key: 'note', type: 'longText', label: 'Note', helper: 'Optional' },
            { key: 'phone', type: 'phone', label: 'Phone' },
            { key: 'age', type: 'number', label: 'Age' },
            { key: 'tags', type: 'multipleChoice', label: 'Interests', options: [{ id: 'a', title: 'A' }] },
            { key: 'city', type: 'dropdown', label: 'City', options: [{ id: 'dxb', title: 'Dubai' }] },
            { key: 'ok', type: 'optIn', label: 'Yes, message me', required: true },
          ],
        },
      ],
    });
    const screen = compileFlowJson(form).screens[0];
    expect(screen?.terminal).toBe(true);
    expect(screen?.layout.children).toEqual([
      { type: 'TextHeading', text: 'Tell us more' },
      { type: 'TextBody', text: 'It takes a minute.' },
      { type: 'TextArea', name: 'note', label: 'Note', required: false, 'helper-text': 'Optional' },
      { type: 'TextInput', name: 'phone', label: 'Phone', 'input-type': 'phone', required: false },
      { type: 'TextInput', name: 'age', label: 'Age', 'input-type': 'number', required: false },
      { type: 'CheckboxGroup', name: 'tags', label: 'Interests', required: false, 'data-source': [{ id: 'a', title: 'A' }] },
      { type: 'Dropdown', name: 'city', label: 'City', required: false, 'data-source': [{ id: 'dxb', title: 'Dubai' }] },
      { type: 'OptIn', name: 'ok', label: 'Yes, message me', required: true },
      {
        type: 'Footer',
        label: 'Send',
        'on-click-action': { name: 'complete', payload: { note: '${form.note}', phone: '${form.phone}', age: '${form.age}', tags: '${form.tags}', city: '${form.city}', ok: '${form.ok}' } },
      },
    ]);
  });

  it('names screens S1…Sn and pins the version', () => {
    expect(FLOW_JSON_VERSION).toBe('7.3');
    expect([0, 1, 9].map(formScreenId)).toEqual(['S1', 'S2', 'S10']);
  });
});
