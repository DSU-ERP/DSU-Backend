// Marks a student's skills onboarding as complete under the CURRENT rules:
// the version comes from the database, identity and visibility are saved, consent
// is recorded and the required platforms are linked. Fixtures use this instead of
// hard-coding a version, so raising the requirements does not silently break them.
export const REQUIRED_FIXTURE_PLATFORMS = Object.freeze(["github", "leetcode", "linkedin"]);

export async function completeOnboarding(db, studentId, { platforms = REQUIRED_FIXTURE_PLATFORMS } = {}) {
  await db.query(
    `INSERT INTO student.skill_profiles(student_id,onboarding_version,onboarding_completed_at,identity_confirmed_at,visibility_saved_at,consent_version,consented_at)
     VALUES($1,student.onboarding_current_version(),now(),now(),now(),1,now())
     ON CONFLICT(student_id) DO UPDATE SET onboarding_version=EXCLUDED.onboarding_version,
       onboarding_completed_at=EXCLUDED.onboarding_completed_at,identity_confirmed_at=EXCLUDED.identity_confirmed_at,
       visibility_saved_at=EXCLUDED.visibility_saved_at,consent_version=EXCLUDED.consent_version,consented_at=EXCLUDED.consented_at`,
    [studentId],
  );
  for (const platform of platforms)
    await db.query(
      `INSERT INTO student.platform_accounts(student_id,platform,state,handle,profile_url,auth_method,ownership)
       VALUES($1,$2,'linked',$3,$4,'link_only','student_submitted')
       ON CONFLICT(student_id,platform) DO UPDATE SET state='linked'`,
      [studentId, platform, `fixture-${platform}`, `https://fixture.invalid/${platform}/${studentId}`],
    );
}
