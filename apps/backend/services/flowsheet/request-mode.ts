import { requestLineModeEnum, spotlightRoleEnum, type SpecialtyShows } from '@wxyc/database';

/** The `request_line_mode` enum's values (api.yaml `RequestLineMode`). */
export const REQUEST_MODES = requestLineModeEnum.enumValues;
export type RequestMode = (typeof REQUEST_MODES)[number];

/** Where the effective mode came from (api.yaml `RequestLine.source`). */
export type RequestModeSource = 'dj' | 'program' | 'spotlight' | 'default';

/** A spotlight row's role (the `spotlight_role` enum's values). */
export type SpotlightRole = (typeof spotlightRoleEnum.enumValues)[number];

/**
 * What the listener request line is for right now (BS#3471). The show's own choice wins; otherwise the program's
 * default; otherwise `requests`, which is also a freeform show's mode (`program` null). The band-and-reader rule
 * (BS#3472) then closes a `requests` result while the current spotlight (its role, `null` for none) is a performer or
 * a reader; it never overrides a DJ's choice and never closes `feedback`.
 */
export const effectiveRequestMode = (
  show: { request_mode: RequestMode | null },
  program: Pick<SpecialtyShows, 'default_request_mode'> | null,
  spotlightRole: SpotlightRole | null = null
): { mode: RequestMode; source: RequestModeSource } => {
  if (show.request_mode != null) {
    return { mode: show.request_mode, source: 'dj' };
  }
  const inherited: { mode: RequestMode; source: RequestModeSource } =
    program?.default_request_mode != null
      ? { mode: program.default_request_mode, source: 'program' }
      : { mode: 'requests', source: 'default' };
  if (inherited.mode === 'requests' && (spotlightRole === 'performer' || spotlightRole === 'reader')) {
    return { mode: 'closed', source: 'spotlight' };
  }
  return inherited;
};
