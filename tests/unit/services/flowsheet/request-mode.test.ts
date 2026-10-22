/**
 * `effectiveRequestMode` (BS#3471): what the listener request line is for, from the show's own choice and its
 * program's default, and (BS#3472) the role of the current spotlight: a band or a reader on air closes a
 * requests-mode line, but never overrides a DJ's choice and never closes feedback.
 */
import {
  effectiveRequestMode,
  type RequestMode,
  type SpotlightRole,
} from '../../../../apps/backend/services/flowsheet/request-mode';

describe('effectiveRequestMode', () => {
  const cases: Array<
    [
      string,
      RequestMode | null,
      { default_request_mode: RequestMode | null } | null,
      SpotlightRole | null,
      RequestMode,
      string,
    ]
  > = [
    [
      'the DJs open requests on a feedback program',
      'requests',
      { default_request_mode: 'feedback' },
      null,
      'requests',
      'dj',
    ],
    ['the DJs choose feedback on a freeform show', 'feedback', null, null, 'feedback', 'dj'],
    [
      'the DJs close the line on a requests-by-default program',
      'closed',
      { default_request_mode: null },
      null,
      'closed',
      'dj',
    ],
    ['a program defaults to feedback', null, { default_request_mode: 'feedback' }, null, 'feedback', 'program'],
    ['a program defaults to closed', null, { default_request_mode: 'closed' }, null, 'closed', 'program'],
    ['a program has no default', null, { default_request_mode: null }, null, 'requests', 'default'],
    ['a freeform show has no program', null, null, null, 'requests', 'default'],
    ['a band is on a requests program', null, { default_request_mode: 'requests' }, 'performer', 'closed', 'spotlight'],
    ['a reader is on a requests program', null, { default_request_mode: 'requests' }, 'reader', 'closed', 'spotlight'],
    ['a band is on a freeform show', null, null, 'performer', 'closed', 'spotlight'],
    ['a reader is on a program with no default', null, { default_request_mode: null }, 'reader', 'closed', 'spotlight'],
    ['a DJ is on air', null, null, 'dj', 'requests', 'default'],
    ['a host is on air', null, null, 'host', 'requests', 'default'],
    ['a guest is in the studio of a freeform show', null, null, 'guest', 'requests', 'default'],
    ['a band is on a feedback program', null, { default_request_mode: 'feedback' }, 'performer', 'feedback', 'program'],
    ['a reader is on a feedback program', null, { default_request_mode: 'feedback' }, 'reader', 'feedback', 'program'],
    ['a band is on a closed program', null, { default_request_mode: 'closed' }, 'performer', 'closed', 'program'],
    ['the DJs open requests while a band is on', 'requests', null, 'performer', 'requests', 'dj'],
    [
      'the DJs open requests while a reader is on',
      'requests',
      { default_request_mode: 'closed' },
      'reader',
      'requests',
      'dj',
    ],
    ['the DJs choose feedback while a band is on', 'feedback', null, 'performer', 'feedback', 'dj'],
  ];

  test.each(cases)('%s', (_name, request_mode, program, spotlight_role, mode, source) => {
    expect(effectiveRequestMode({ request_mode }, program, spotlight_role)).toEqual({ mode, source });
  });
});
