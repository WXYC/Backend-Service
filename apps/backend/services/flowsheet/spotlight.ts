import { spotlightRoleEnum, type FSEntry } from '@wxyc/database';
import { validateEnumField, validateTextField } from '../../utils/text-fields.js';

export type SpotlightRole = NonNullable<FSEntry['spotlight_role']>;

/** The `spotlight_role` enum's values (migration 0201). */
export const SPOTLIGHT_ROLES: readonly SpotlightRole[] = spotlightRoleEnum.enumValues;

/** Width of `flowsheet.spotlight_name`. */
export const SPOTLIGHT_NAME_MAX_LENGTH = 128;

const MESSAGE_PREFIX: Record<SpotlightRole, string> = {
  performer: 'Live in the studio',
  host: 'Live in the studio',
  reader: 'Reading now',
  dj: 'Now mixing',
  guest: 'In the studio',
};

/** The `message` a spotlight row carries; the server composes it and ignores any client-sent one. */
export const composeSpotlightMessage = (role: SpotlightRole, name: string): string =>
  `${MESSAGE_PREFIX[role]}: ${name}`;

/** 400 for a role outside the enum. */
export const validateSpotlightRole = (value: unknown): SpotlightRole =>
  validateEnumField(value, 'spotlight_role', SPOTLIGHT_ROLES);

/** 400 for a blank or over-long name; returns it trimmed. */
export const validateSpotlightName = (value: unknown): string =>
  validateTextField(value, 'spotlight_name', SPOTLIGHT_NAME_MAX_LENGTH);
