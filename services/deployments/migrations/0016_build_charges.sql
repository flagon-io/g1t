-- A sandbox build's seconds are charged once billing confirms them
-- (`build_charged_at`); until then the sweep tries again, so a build is
-- never left uncharged by billing being briefly unreachable. Billing
-- records each build's reference (`deploy/<id>`) once, so a try whose
-- answer was lost cannot charge it twice. Builds that finished before this
-- were charged, or not, as they finished, and are not tried again.
ALTER TABLE deployments ADD COLUMN build_charged_at TEXT;
UPDATE deployments SET build_charged_at = 'before: charged as it finished' WHERE build_seconds IS NOT NULL;
CREATE INDEX IF NOT EXISTS deployments_build_uncharged ON deployments (finished_at)
  WHERE build_charged_at IS NULL AND build_seconds > 0;
