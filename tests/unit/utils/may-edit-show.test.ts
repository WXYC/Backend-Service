/**
 * Decision table for `mayEditShow` (BS#3455): who may edit an existing show or a row of it. The module is pure, so
 * each case is a fake caller and a fake show.
 */
import { mayEditShow, ShowEditCaller, ShowEditTarget } from '../../../apps/backend/utils/may-edit-show';

const dj: ShowEditCaller = { id: 'dj-a', canManageFlowsheet: false };
const manager: ShowEditCaller = { id: 'md-1', canManageFlowsheet: true };

const openShow: ShowEditTarget = { end_time: null, latest_entry_is_show_end: false, dj_ids: ['dj-a', 'dj-b'] };
const endedShow: ShowEditTarget = { ...openShow, end_time: new Date('2026-10-01T02:00:00Z') };
const droppedShowEnd: ShowEditTarget = { ...openShow, latest_entry_is_show_end: true };

describe('mayEditShow (BS#3455)', () => {
  const table: Array<[string, ShowEditCaller, ShowEditTarget, unknown]> = [
    ['a member of an open show', dj, openShow, { allowed: true }],
    ['a co-host of an open show', { ...dj, id: 'dj-b' }, openShow, { allowed: true }],
    ['a non-member of an open show', { ...dj, id: 'dj-z' }, openShow, { allowed: false, status: 400 }],
    ['a manager who is not on an open show', manager, openShow, { allowed: true }],
    ['a manager who is on an open show', { ...manager, id: 'dj-a' }, openShow, { allowed: true }],
    ['a manager on an ended show', manager, endedShow, { allowed: true }],
    [
      'a member of an ended show who cannot manage',
      dj,
      endedShow,
      { allowed: false, status: 403, code: 'closed_show' },
    ],
    [
      'a member whose show has NULL end_time but a show_end newest row',
      dj,
      droppedShowEnd,
      { allowed: false, status: 403, code: 'closed_show' },
    ],
    ['a manager on a show with NULL end_time but a show_end newest row', manager, droppedShowEnd, { allowed: true }],
  ];

  test.each(table)('%s', (_name, caller, show, expected) => {
    expect(mayEditShow(caller, show)).toMatchObject(expected as object);
  });
});
