// Moved to @bendyline/gezel (core) so authoring surfaces — the catalog
// template lint, the craftbook editor, MCP create paths — can validate
// gate-script inputs against a script's meta without depending on the
// service. Re-exported here so existing service imports keep working.
export { ScriptInputError, validateScriptInput } from '@bendyline/gezel';
