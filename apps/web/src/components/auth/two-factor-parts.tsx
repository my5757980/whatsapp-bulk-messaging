'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Feature 010 (US6): pieces shared by the sign-in steps and the account page.

export interface TwoFactorSetup {
  secret: string;
  otpauthUrl: string;
  qrSvg: string;
}

/** The QR code to scan, the secret to type, and the box for the first code. */
export function SetupSecret({ setup }: { setup: TwoFactorSetup }) {
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">Scan the code with an authenticator app (such as Google Authenticator or Microsoft Authenticator), or type the key.</p>
      {/* Our own QR image (server-made SVG), shown as an image so no markup is injected. */}
      <img src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} alt="QR code for your authenticator app" className="h-44 w-44 rounded-md border bg-white p-2" />
      <div className="grid gap-1">
        <span className="text-xs text-muted-foreground">Key</span>
        <code className="break-all rounded-md bg-muted px-2 py-1 font-mono text-sm" data-testid="totp-secret">
          {setup.secret}
        </code>
      </div>
    </div>
  );
}

/** A 6-digit code box. */
export function CodeField({ id, value, onChange, label = 'Code from your app' }: { id: string; value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="123456"
      />
    </div>
  );
}

/** The recovery codes, shown once, with a copy button and a confirmation to continue. */
export function RecoveryCodesList({ codes, onDone, doneLabel = 'I saved my codes' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        Save these recovery codes somewhere safe. Each one signs you in once if you lose your phone. <strong>They are shown only now.</strong>
      </p>
      <ul className="grid grid-cols-2 gap-1 rounded-md border bg-muted p-3 font-mono text-sm" data-testid="recovery-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(codes.join('\n')).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
        <Button type="button" onClick={onDone}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
