// Our form model compiled to static Flow JSON (feature 008, research R12). No data_api_version or
// routing_model: a static form needs no endpoint. Earlier screens' answers are read with
// ${screen.<id>.form.<field>} global references (verify; T083). Pure.
import type { FormField, FormModel } from './forms.js';

export const FLOW_JSON_VERSION = '7.3';

export const formScreenId = (index: number): string => `S${index + 1}`;

type Component = Record<string, unknown>;

export interface FlowJsonScreen {
  id: string;
  title: string;
  terminal?: true;
  layout: { type: 'SingleColumnLayout'; children: Component[] };
}

export interface FlowJson {
  version: string;
  screens: FlowJsonScreen[];
}

const INPUT_TYPE: Partial<Record<FormField['type'], string>> = { shortText: 'text', email: 'email', phone: 'phone', number: 'number' };
const CHOICE_COMPONENT: Partial<Record<FormField['type'], string>> = { singleChoice: 'RadioButtonsGroup', multipleChoice: 'CheckboxGroup', dropdown: 'Dropdown' };

function component(field: FormField): Component {
  const helper = field.helper ? { 'helper-text': field.helper } : {};
  const inputType = INPUT_TYPE[field.type];
  if (inputType) return { type: 'TextInput', name: field.key, label: field.label, 'input-type': inputType, required: field.required, ...helper };
  const choice = CHOICE_COMPONENT[field.type];
  if (choice) {
    return { type: choice, name: field.key, label: field.label, required: field.required, 'data-source': (field.options ?? []).map((o) => ({ id: o.id, title: o.title })) };
  }
  if (field.type === 'longText') return { type: 'TextArea', name: field.key, label: field.label, required: field.required, ...helper };
  if (field.type === 'date') return { type: 'DatePicker', name: field.key, label: field.label, required: field.required, ...helper };
  return { type: 'OptIn', name: field.key, label: field.label, required: field.required };
}

export function compileFlowJson(model: FormModel): FlowJson {
  const last = model.screens.length - 1;
  const screens = model.screens.map((screen, index): FlowJsonScreen => {
    const children: Component[] = [];
    if (screen.heading) children.push({ type: 'TextHeading', text: screen.heading });
    if (screen.text) children.push({ type: 'TextBody', text: screen.text });
    children.push(...screen.fields.map(component));
    if (index < last) {
      children.push({ type: 'Footer', label: screen.button, 'on-click-action': { name: 'navigate', next: { type: 'screen', name: formScreenId(index + 1) }, payload: {} } });
    } else {
      const payload: Record<string, string> = {};
      model.screens.forEach((s, at) => {
        for (const field of s.fields) payload[field.key] = at === last ? `\${form.${field.key}}` : `\${screen.${formScreenId(at)}.form.${field.key}}`;
      });
      children.push({ type: 'Footer', label: screen.button, 'on-click-action': { name: 'complete', payload } });
    }
    return {
      id: formScreenId(index),
      title: screen.title,
      ...(index === last ? { terminal: true as const } : {}),
      layout: { type: 'SingleColumnLayout', children },
    };
  });
  return { version: FLOW_JSON_VERSION, screens };
}
