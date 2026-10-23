-- Skills profile onboarding v2: GitHub, LeetCode and LinkedIn are required
-- linked profiles. HackerRank, Hugging Face and Kaggle remain optional.

CREATE OR REPLACE FUNCTION student.onboarding_current_version() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT 2
$$;

CREATE OR REPLACE FUNCTION student.skill_status(target uuid) RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT CASE WHEN p.student_id IS NULL THEN 'not_started'
    WHEN p.onboarding_version>=student.onboarding_current_version()
      AND (SELECT count(DISTINCT a.platform) FROM student.platform_accounts a
        WHERE a.student_id=target AND a.platform IN ('github','leetcode','linkedin')
          AND a.state='linked')=3
    THEN 'complete' ELSE 'incomplete' END
  FROM (SELECT 1) one LEFT JOIN student.skill_profiles p ON p.student_id=target
$$;
