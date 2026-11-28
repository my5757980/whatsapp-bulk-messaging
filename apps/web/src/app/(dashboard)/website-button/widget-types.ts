// Feature 009 (US8): the website chat button as the api returns it (contracts/templates-growth-api ChatWidget).

export interface WidgetLook {
  colour: string;
  buttonText: string;
  corner: 'BOTTOM_LEFT' | 'BOTTOM_RIGHT';
  offsetX: number;
  offsetY: number;
  radius: number;
}

export interface WidgetRule {
  id?: string;
  match: 'EXACT' | 'PREFIX' | 'CONTAINS';
  value: string;
  hide: boolean;
  greeting?: string | null;
  message?: string | null;
}

export interface ChatWidgetInput {
  name: string;
  numberId: string;
  look: WidgetLook;
  brandName: string;
  brandImageAssetId: string | null;
  greeting: string;
  message: string;
  rules: WidgetRule[];
}

export interface ChatWidget extends ChatWidgetInput {
  id: string;
  key: string;
  numberLabel: string;
  status: 'ACTIVE' | 'PAUSED';
  snippet: string;
  numberConnected: boolean;
  last30Days: { opens: number; chatsStarted: number };
}

export interface ChatWidgetStats {
  from: string;
  to: string;
  opensByPage: Array<{ page: string; opens: number }>;
  chatsByRule: Array<{ ruleId: string | null; label: string; chatsStarted: number; newContacts: number }>;
}
