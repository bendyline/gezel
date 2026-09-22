/**
 * Transport-independent input contracts, one per tool, used by the MCP
 * server and the embedded portable host. A host may `.extend` one with
 * fields only it supports; the base is what both accept.
 */
export * from './inputs/common.js';
export * from './inputs/files.js';
export * from './inputs/memory.js';
export * from './inputs/projects.js';
export * from './inputs/questions.js';
export * from './inputs/scripts.js';
export * from './inputs/search.js';
export * from './inputs/tasks.js';
export * from './inputs/team.js';
