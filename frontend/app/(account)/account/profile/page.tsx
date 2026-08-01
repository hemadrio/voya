/**
 * Profile management page (WO-069, AC9).
 */

export const dynamic = "force-dynamic";

import { getProfile } from "@/lib/api/account.js";
import { ProfileForm } from "@/components/account/ProfileForm.js";

export default async function ProfilePage() {
  let profile;
  try {
    profile = await getProfile();
  } catch {
    return (
      <div role="alert" className="rounded-md border border-error-300 bg-error-50 p-4 text-sm text-error-700">
        Unable to load your profile. Please refresh the page.
      </div>
    );
  }

  return (
    <>
      <h1 className="mb-4 text-xl font-bold text-neutral-900">Profile</h1>
      <ProfileForm profile={profile} />
    </>
  );
}
