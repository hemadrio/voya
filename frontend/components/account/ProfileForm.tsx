"use client";

/**
 * ProfileForm — profile editing with inline validation and optimistic save (WO-069, AC9).
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/Button.js";
import { Input } from "@/components/ui/Input.js";
import { useToast } from "@/components/ui/Toast.js";
import { updateProfile } from "@/lib/api/account.js";
import type { Profile } from "@/lib/api/account.js";
import { ApiError } from "@/lib/api/errors.js";

const ProfileSchema = z.object({
  firstName: z.string().min(1, "First name is required").max(64),
  lastName: z.string().min(1, "Last name is required").max(64),
  phone: z.string().regex(/^\+?[0-9\s\-().]{7,20}$/, "Enter a valid phone number").optional().or(z.literal("")),
  locale: z.string().min(2),
  currency: z.string().length(3, "Currency must be a 3-letter code"),
  marketingOptIn: z.boolean(),
});

type ProfileFormValues = z.infer<typeof ProfileSchema>;

// Avatar validation: client-side before upload
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const AVATAR_ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

interface ProfileFormProps {
  profile: Profile;
  onSaved?: (updated: Profile) => void;
}

export function ProfileForm({ profile, onSaved }: ProfileFormProps) {
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const { addToast } = useToast();

  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(ProfileSchema),
    defaultValues: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      phone: profile.phone ?? "",
      locale: profile.locale,
      currency: profile.currency,
      marketingOptIn: profile.marketingOptIn,
    },
  });

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!AVATAR_ALLOWED_TYPES.includes(file.type)) {
      setAvatarError("Please upload a JPEG, PNG, or WebP image.");
      e.target.value = "";
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError("Image must be under 5 MB.");
      e.target.value = "";
      return;
    }
    setAvatarError(null);
  }

  async function onSubmit(values: ProfileFormValues) {
    try {
      const updated = await updateProfile(values);
      addToast({ message: "Profile saved.", variant: "success" });
      onSaved?.(updated);
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) {
        // Bind field-level server errors
        for (const [field, message] of Object.entries(err.fieldErrors)) {
          form.setError(field as keyof ProfileFormValues, { message });
        }
      } else {
        addToast({ message: "Unable to save profile. Please try again.", variant: "error" });
      }
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="pf-firstName" className="mb-1 block text-sm font-medium text-neutral-700">
            First name <span aria-hidden>*</span>
          </label>
          <Input
            id="pf-firstName"
            autoComplete="given-name"
            aria-required="true"
            aria-invalid={!!form.formState.errors.firstName}
            {...form.register("firstName")}
          />
          {form.formState.errors.firstName && (
            <p role="alert" className="mt-1 text-xs text-error-600">
              {form.formState.errors.firstName.message}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="pf-lastName" className="mb-1 block text-sm font-medium text-neutral-700">
            Last name <span aria-hidden>*</span>
          </label>
          <Input
            id="pf-lastName"
            autoComplete="family-name"
            aria-required="true"
            aria-invalid={!!form.formState.errors.lastName}
            {...form.register("lastName")}
          />
          {form.formState.errors.lastName && (
            <p role="alert" className="mt-1 text-xs text-error-600">
              {form.formState.errors.lastName.message}
            </p>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="pf-phone" className="mb-1 block text-sm font-medium text-neutral-700">Phone</label>
        <Input id="pf-phone" type="tel" autoComplete="tel" {...form.register("phone")} />
        {form.formState.errors.phone && (
          <p role="alert" className="mt-1 text-xs text-error-600">{form.formState.errors.phone.message}</p>
        )}
      </div>

      <div>
        <label htmlFor="pf-avatar" className="mb-1 block text-sm font-medium text-neutral-700">
          Profile photo
        </label>
        <input
          id="pf-avatar"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleAvatarChange}
          className="block text-sm text-neutral-600 file:mr-3 file:rounded file:border file:border-neutral-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-neutral-50"
        />
        {avatarError && <p role="alert" className="mt-1 text-xs text-error-600">{avatarError}</p>}
        <p className="mt-1 text-xs text-neutral-400">JPEG, PNG or WebP up to 5 MB</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="pf-locale" className="mb-1 block text-sm font-medium text-neutral-700">Language</label>
          <Input id="pf-locale" {...form.register("locale")} placeholder="en-GB" />
        </div>
        <div>
          <label htmlFor="pf-currency" className="mb-1 block text-sm font-medium text-neutral-700">Currency</label>
          <Input id="pf-currency" maxLength={3} {...form.register("currency")} placeholder="GBP" />
          {form.formState.errors.currency && (
            <p role="alert" className="mt-1 text-xs text-error-600">{form.formState.errors.currency.message}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="pf-marketing"
          type="checkbox"
          {...form.register("marketingOptIn")}
          className="h-4 w-4 rounded border-neutral-300 text-brand-600"
        />
        <label htmlFor="pf-marketing" className="text-sm text-neutral-700">
          Receive travel offers and inspiration
        </label>
      </div>

      <Button type="submit" loading={form.formState.isSubmitting}>
        Save changes
      </Button>
    </form>
  );
}
