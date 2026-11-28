// Feature 010 (US6, contracts/contacts-settings-api.openapi.yaml MyTwoFactor): the signed-in member's state.

export interface MyTwoFactor {
  enabled: boolean;
  enabledAt: string | null;
  required: boolean;
  recoveryCodesLeft: number;
}

export const myTwoFactorKey = ['me', '2fa'] as const;
