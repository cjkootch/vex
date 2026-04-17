"use client";

import type { ReactNode } from "react";

export interface FormFieldProps {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}

/**
 * Label + slot wrapper. Used by every Sprint-14 create form so the
 * look of a field stays consistent across company / contact / deal
 * modals without pulling in a form library.
 */
export function FormField({ label, required, hint, error, children }: FormFieldProps) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-white/80">
        {label}
        {required && <span className="ml-0.5 text-accent">*</span>}
      </span>
      {children}
      {error && <span className="text-xs text-bad">{error}</span>}
      {!error && hint && <span className="text-xs text-white/40">{hint}</span>}
    </label>
  );
}

const INPUT_CLASSES =
  "rounded-md border border-line bg-muted/40 px-3 py-1.5 text-sm text-white placeholder:text-white/40 focus:border-accent focus:outline-none";

export function TextInput(
  props: Omit<React.InputHTMLAttributes<HTMLInputElement>, "className">,
) {
  return <input {...props} className={INPUT_CLASSES} />;
}

export function TextArea(
  props: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "className">,
) {
  return <textarea {...props} className={`${INPUT_CLASSES} min-h-[72px]`} />;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Select({
  options,
  ...rest
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "className"> & {
  options: SelectOption[];
}) {
  return (
    <select {...rest} className={INPUT_CLASSES}>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value} disabled={opt.disabled}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
