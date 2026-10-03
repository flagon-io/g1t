-- Where a pull request g1t is seeing through stood when it was last
-- assessed, so lists can show it without working it out again. Written on
-- every assessment: each event, each view of the pull request, each sweep.
ALTER TABLE pulls ADD COLUMN stage TEXT;
ALTER TABLE pulls ADD COLUMN stage_detail TEXT;
