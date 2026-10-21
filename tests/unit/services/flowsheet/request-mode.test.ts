/**
 * `effectiveRequestMode` (BS#3471): what the listener request line is for, from the show's own choice and its
 * program's default. The band-and-reader rule (BS#3472) adds a third input later.
 */
import { effectiveRequestMode, type RequestMode } from '../../../../apps/backend/services/flowsheet/request-mode';

describe('effectiveRequestMode', () => {
  const cases: Array<
    [string, RequestMode | null, { default_request_mode: RequestMode | null } | null, RequestMode, string]
  > = [
    ['the DJs open requests on a feedback program', 'requests', { default_request_mode: 'feedback' }, 'requests', 'dj'],
    ['the DJs choose feedback on a freeform show', 'feedback', null, 'feedback', 'dj'],
    [
      'the DJs close the line on a requests-by-default program',
      'closed',
      { default_request_mode: null },
      'closed',
      'dj',
    ],
    ['a program defaults to feedback', null, { default_request_mode: 'feedback' }, 'feedback', 'program'],
    ['a program defaults to closed', null, { default_request_mode: 'closed' }, 'closed', 'program'],
    ['a program has no default', null, { default_request_mode: null }, 'requests', 'default'],
    ['a freeform show has no program', null, null, 'requests', 'default'],
  ];

  test.each(cases)('%s', (_name, request_mode, program, mode, source) => {
    expect(effectiveRequestMode({ request_mode }, program)).toEqual({ mode, source });
  });
});
