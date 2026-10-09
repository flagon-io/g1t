-- The most a run may spend on models, in millionths of a dollar: the lower
-- of its project's cost cap and its plan's, set by the sandbox once it
-- knows them. The model proxy refuses the run's requests past it. Null
-- until set; the proxy then holds the run to the most any run may cost.
ALTER TABLE model_sessions ADD COLUMN cap_micros INTEGER;
