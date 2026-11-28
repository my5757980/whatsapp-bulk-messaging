'use client';

import { useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

interface ConfirmDialogProps {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonProps['variant'];
  onConfirm: () => Promise<unknown>;
  /** Feature 010: the confirm button waits until this exact text is typed (e.g. the phone number). */
  typeToConfirm?: string;
}

/** Confirmation step for actions that are hard to undo (pause, cancel, delete, disconnect). */
export function ConfirmDialog({ trigger, title, description, confirmLabel, confirmVariant = 'default', onConfirm, typeToConfirm }: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const matches = !typeToConfirm || typed.trim() === typeToConfirm;
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {typeToConfirm ? (
          <div className="grid gap-1.5">
            <Label htmlFor="type-to-confirm">
              Type <strong>{typeToConfirm}</strong> to confirm
            </Label>
            <Input id="type-to-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Keep as is
          </Button>
          <Button variant={confirmVariant} onClick={confirm} disabled={busy || !matches}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
