'use client';

import { createContext, useContext, type ComponentProps } from 'react';
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';
import { cn } from '@/lib/utils';
import { Label } from './label';

export const Form = FormProvider;

const FormFieldContext = createContext<{ name: string }>({ name: '' });

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

export function useFormField() {
  const { name } = useContext(FormFieldContext);
  const { getFieldState, formState } = useFormContext();
  const state = getFieldState(name, formState);
  return { name, id: `field-${name}`, ...state };
}

export function FormItem({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('grid gap-2', className)} {...props} />;
}

export function FormLabel({ className, ...props }: ComponentProps<typeof Label>) {
  const { id, error } = useFormField();
  return <Label htmlFor={id} className={cn(error && 'text-destructive', className)} {...props} />;
}

export function FormMessage({ className, children, ...props }: ComponentProps<'p'>) {
  const { error } = useFormField();
  const body = error?.message ? String(error.message) : children;
  if (!body) return null;
  return (
    <p role="alert" className={cn('text-sm text-destructive', className)} {...props}>
      {body}
    </p>
  );
}
