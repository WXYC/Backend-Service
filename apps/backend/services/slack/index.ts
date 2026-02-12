/**
 * Barrel export for Slack services.
 */

export { buildSlackBlocks, buildSimpleSlackBlocks, type SlackBlock } from './builder.js';
export { postTextToSlack, postBlocksToSlack, isSlackConfigured, type SlackPostResult } from './slack.service.js';
