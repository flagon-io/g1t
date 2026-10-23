-- Whether a runner runs jobs asking for a hosted label in g1t's runner
-- image (1) or not (0), as it last said at registration or in a poll
-- (`runners::RegisterArgs::hosted_image`). Null for a runner that never
-- said (before g1t-runner 0.3.7), which takes none of those jobs: in its
-- own image they find none of what g1t's machines have (flagon-io#458).
ALTER TABLE runners ADD COLUMN hosted_image INTEGER;
