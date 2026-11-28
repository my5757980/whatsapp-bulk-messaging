// Feature 010 (US5, contracts/contacts-settings-api.openapi.yaml tag date-automations): templates sent on dates
// stored in contact attributes.

export type AutomationTiming = 'YEARLY' | 'ONCE';
export type AutomationStatus = 'ON' | 'OFF' | 'PAUSED';
export type PauseReason = 'TEMPLATE_NOT_APPROVED' | 'NUMBER_DISCONNECTED' | 'SENDING_OFF';
export type MappingSource = { source: 'field' | 'attribute' | 'global' | 'static'; key?: string; value?: string; fallback?: string };

export interface DateAutomation {
  id: string;
  name: string;
  attributeKey: string;
  timing: AutomationTiming;
  offsetDays: number;
  sendTime: string;
  numberId: string;
  numberLabel: string;
  templateId: string;
  templateName: string;
  variableMapping: Record<string, MappingSource>;
  status: AutomationStatus;
  pausedReason: PauseReason | null;
  last7Days: { sent: number; failed: number; skipped: number };
  createdAt: string;
  updatedAt: string;
}

export interface AutomationInput {
  name: string;
  attributeKey: string;
  timing: AutomationTiming;
  offsetDays: number;
  sendTime: string;
  numberId: string;
  templateId: string;
  variableMapping: Record<string, MappingSource>;
}

export interface AutomationDay {
  date: string;
  due: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: Record<string, number>;
}

export interface AutomationRecipient {
  contactId: string;
  name: string | null;
  phone: string;
  status: 'PENDING' | 'SENT' | 'SKIPPED' | 'FAILED';
  reason: string | null;
  messageStatus: string | null;
}

export const automationKeys = {
  list: ['date-automations'] as const,
  one: (id: string) => ['date-automations', id] as const,
  results: (id: string) => ['date-automations', id, 'results'] as const,
  recipients: (id: string, date: string, page: number) => ['date-automations', id, 'recipients', date, page] as const,
};

export const AUTOMATION_STATUS_LABEL: Record<AutomationStatus, string> = { ON: 'On', OFF: 'Off', PAUSED: 'Paused' };
export const AUTOMATION_STATUS_VARIANT: Record<AutomationStatus, 'success' | 'secondary' | 'warning'> = { ON: 'success', OFF: 'secondary', PAUSED: 'warning' };
export const PAUSE_TEXT: Record<PauseReason, string> = {
  TEMPLATE_NOT_APPROVED: 'Paused because its template is not approved. Choose an approved template, then switch it on.',
  NUMBER_DISCONNECTED: 'Paused because its WhatsApp number is not connected. Reconnect the number, then switch it on.',
  SENDING_OFF: 'Paused because sending is turned off for its number. Turn sending on, then switch it on.',
};
export const SKIP_LABEL: Record<string, string> = {
  opted_out: 'opted out',
  blocked: 'blocked',
  invalid: 'invalid number',
  no_date: 'no date',
  missing_value: 'missing value',
  not_opted_in: 'not opted in',
  too_late: 'too late',
  cancelled: 'cancelled',
  send_failed: 'send failed',
};

/** "On the date", "3 days before", "1 day after". */
export function offsetText(offsetDays: number): string {
  if (offsetDays === 0) return 'on the date';
  const days = Math.abs(offsetDays);
  return `${days} day${days === 1 ? '' : 's'} ${offsetDays < 0 ? 'before' : 'after'}`;
}
