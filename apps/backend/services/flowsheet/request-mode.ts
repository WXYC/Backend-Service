import { requestLineModeEnum, type SpecialtyShows } from '@wxyc/database';

/** The `request_line_mode` enum's values (api.yaml `RequestLineMode`). */
export const REQUEST_MODES = requestLineModeEnum.enumValues;
export type RequestMode = (typeof REQUEST_MODES)[number];

/** Where the effective mode came from (api.yaml `RequestLine.source`). */
export type RequestModeSource = 'dj' | 'program' | 'default';

/**
 * What the listener request line is for right now (BS#3471). The show's own choice wins; otherwise the program's
 * default; otherwise `requests`, which is also a freeform show's mode (`program` null). The band-and-reader rule
 * (BS#3472) will add the current spotlight as a third input; it never closes `feedback`.
 */
export const effectiveRequestMode = (
  show: { request_mode: RequestMode | null },
  program: Pick<SpecialtyShows, 'default_request_mode'> | null
): { mode: RequestMode; source: RequestModeSource } => {
  if (show.request_mode != null) {
    return { mode: show.request_mode, source: 'dj' };
  }
  if (program?.default_request_mode != null) {
    return { mode: program.default_request_mode, source: 'program' };
  }
  return { mode: 'requests', source: 'default' };
};
