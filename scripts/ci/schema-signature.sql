-- Everything that makes up the public schema, listed so two databases can be
-- diffed however they were built. Column position is left out on purpose:
-- a column a migration adds lands last in its table, while schema.sql may
-- declare it in the middle.

SELECT 'column' AS kind,
       table_name || '.' || column_name AS name,
       concat_ws(' ', data_type,
                 CASE WHEN is_nullable = 'NO' THEN 'not null' END,
                 'default ' || column_default) AS definition
  FROM information_schema.columns
 WHERE table_schema = 'public'
UNION ALL
SELECT 'constraint', conrelid::regclass || '.' || conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE connamespace = 'public'::regnamespace
UNION ALL
SELECT 'index', tablename || '.' || indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
UNION ALL
SELECT 'trigger', event_object_table || '.' || trigger_name,
       action_timing || ' ' || event_manipulation || ' ' || action_statement
  FROM information_schema.triggers
 WHERE trigger_schema = 'public'
UNION ALL
SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       md5(pg_get_functiondef(p.oid))
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
UNION ALL
SELECT 'view', table_name, md5(view_definition)
  FROM information_schema.views
 WHERE table_schema = 'public'
ORDER BY 1, 2, 3;
