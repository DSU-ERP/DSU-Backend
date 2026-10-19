-- Route conversation renames through the same verified backend actor context.
GRANT EXECUTE ON FUNCTION public.dsu_friday_rename(uuid,text) TO dsu_api;
-- Keep the existing web release working until the explicit RPC cutover.
