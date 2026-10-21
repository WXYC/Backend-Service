/**
 * Configuration for the flowsheet `spotlight` entry type (BS#3459, epic BS#3445).
 *
 * A spotlight row says who is on air inside a show. Until the DJ site's live flowsheet stops throwing on an unknown
 * entry type and the Android app stops printing it as a "SPOTLIGHT" card, no spotlight may reach the wire, so turning
 * spotlights on is an environment change rather than a code release. While the flag is off, `POST /flowsheet` with
 * `entry_type: spotlight` and a `PATCH /flowsheet` carrying `spotlight_role` or `spotlight_name` answer 403
 * `spotlight_disabled` before any service read, and nothing is written or broadcast.
 *
 * Off by default and strict: only the string `'true'` enables it, same as {@link ./flowsheetTakeover.ts}. The singleton
 * mechanics come from the shared {@link createEnvFlagConfig} factory; tests that mutate
 * `process.env.FLOWSHEET_SPOTLIGHT_ENABLED` between cases must call `resetConfig()`.
 */
import { createEnvFlagConfig, type EnvFlagConfig } from './envFlag.js';

export type FlowsheetSpotlightConfig = EnvFlagConfig;

export const { loadConfig, getConfig, resetConfig } = createEnvFlagConfig('FLOWSHEET_SPOTLIGHT_ENABLED');
