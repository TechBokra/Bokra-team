-- =====================================================================
-- 003_approvals_and_fixes.sql
-- 1) task_attachments: columns the server already writes (file_size, mime_type)
-- 2) Requests (leave / overtime / expense / work contract):
--    - the owner can edit or withdraw a request only while it is pending
--      (before: an employee could set their own request to "approved")
--    - members with the matching approve_* permission can decide requests
--      of people under them (get_my_hierarchy), not their own
-- 3) Penalties: issue_penalties can issue to people under you,
--    approve_penalties can decide them, the penalised member can only appeal.
-- 4) Notifications: everyone could read/update every notification; now only
--    the recipient (or an admin).
-- =====================================================================

ALTER TABLE public.task_attachments
    ADD COLUMN IF NOT EXISTS file_size bigint,
    ADD COLUMN IF NOT EXISTS mime_type text;

-- Can the current user decide a request of this member with this permission?
CREATE OR REPLACE FUNCTION public.can_approve_for(p_member_id integer, p_permission text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.is_admin()
      OR (public.has_permission(p_permission)
          AND p_member_id IS DISTINCT FROM public.get_current_team_member_id()
          AND p_member_id IN (SELECT public.get_my_hierarchy()));
$$;
GRANT EXECUTE ON FUNCTION public.can_approve_for(integer, text) TO authenticated;

-- ---------------------------------------------------------------------
-- Request tables share the same shape of rules
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('leave_requests', 'approve_leave_requests'),
      ('overtime_requests', 'approve_overtime'),
      ('expense_claims', 'approve_expense_claims'),
      ('work_contract_change_requests', 'approve_work_contract_changes')
    ) AS v(tbl, perm)
  LOOP
    -- drop the old catch-all and update/delete policies
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.tbl || '_all_policy', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.tbl || '_update_policy_v2', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.tbl || '_delete_policy_v2', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'work_contract_update_policy_v2', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'work_contract_delete_policy_v2', t.tbl);

    -- owner edits / withdraws while pending; approvers decide
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
      USING (
        (team_member_id = public.get_current_team_member_id() AND status = 'pending')
        OR public.can_approve_for(team_member_id, %L)
      )
      WITH CHECK (
        (team_member_id = public.get_current_team_member_id() AND status = 'pending')
        OR public.can_approve_for(team_member_id, %L)
      )$p$, t.tbl || '_update_v3', t.tbl, t.perm, t.perm);

    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
      USING (
        (team_member_id = public.get_current_team_member_id() AND status = 'pending')
        OR public.is_admin()
      )$p$, t.tbl || '_delete_v3', t.tbl);

    -- approvers must see what they decide
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
      USING (public.can_approve_for(team_member_id, %L))$p$, t.tbl || '_select_approver_v3', t.tbl, t.perm);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------
-- Penalties
-- ---------------------------------------------------------------------
CREATE POLICY penalties_insert_v3 ON public.penalties FOR INSERT TO authenticated
  WITH CHECK (public.can_approve_for(team_member_id, 'issue_penalties'));

CREATE POLICY penalties_decide_v3 ON public.penalties FOR UPDATE TO authenticated
  USING (public.can_approve_for(team_member_id, 'approve_penalties'))
  WITH CHECK (public.can_approve_for(team_member_id, 'approve_penalties'));

-- the penalised member may only file an appeal
CREATE POLICY penalties_appeal_v3 ON public.penalties FOR UPDATE TO authenticated
  USING (team_member_id = public.get_current_team_member_id() AND status IN ('pending', 'approved'))
  WITH CHECK (team_member_id = public.get_current_team_member_id() AND status = 'appealed');

CREATE POLICY penalties_select_issuer_v3 ON public.penalties FOR SELECT TO authenticated
  USING (public.can_approve_for(team_member_id, 'issue_penalties') OR issuer_id = public.get_current_team_member_id());

-- ---------------------------------------------------------------------
-- Notifications: recipient only
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can read own notifications" ON public.notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;
