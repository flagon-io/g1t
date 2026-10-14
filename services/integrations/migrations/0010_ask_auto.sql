-- Auto for Ask: each question goes to the connection's model that suits it.
-- 1 on a route means Auto; its `model` is then not read. Code that does not
-- know this column keeps answering with `model`, so this runs before it.
ALTER TABLE model_routes ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;

-- Auto is the default, and Ask's routes made before it get it unless their
-- owner chose a model: the old picker started at the first model the
-- provider listed (or none), so a route with that model is one nobody
-- picked. An Azure deployment is named by its owner, so it stays.
UPDATE model_routes SET auto = 1
WHERE task = 'ask'
  AND connection_id IN (
    SELECT id FROM connections
    WHERE provider != 'azure_openai' AND models IS NOT NULL AND json_valid(models) AND json_array_length(models) > 0
  )
  AND (
    model IS NULL
    OR model = (SELECT json_extract(c.models, '$[0]') FROM connections c WHERE c.id = model_routes.connection_id)
  );
