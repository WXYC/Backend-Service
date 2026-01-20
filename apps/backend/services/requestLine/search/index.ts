/**
 * Barrel export for search module.
 */

export { executeSearchPipeline, type PipelineOptions } from './pipeline.js';
export { getSearchTypeFromState, createSearchState, type SearchState } from './state.js';
export * from './strategies/index.js';
