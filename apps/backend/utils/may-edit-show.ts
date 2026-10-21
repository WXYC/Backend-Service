/**
 * The one rule for who may edit an existing show, or a row of it (BS#3455). While the show is on the air, any active
 * DJ on it (primary or co-host) may. Once it has ended, only a caller holding `flowsheet: manage` (music directors and
 * station managers) may. Callers turn the decision into a response; a later window for a show's own DJs after sign-off
 * (BS#2701) belongs here.
 */

export type ShowEditCaller = {
  id: string;
  /** Holds `flowsheet: manage`. */
  canManageFlowsheet: boolean;
};

export type ShowEditTarget = {
  end_time: Date | null;
  /** The show's newest row is a `show_end` marker (BS#2065: the dropped deliveries that leave `end_time` NULL). */
  latest_entry_is_show_end: boolean;
  /** Ids of the show's active DJs. Only read while the show is on the air. */
  dj_ids: string[];
};

export type ShowEditDecision =
  { allowed: true } | { allowed: false; status: 400 | 403; message: string; code?: 'closed_show' };

export const mayEditShow = (caller: ShowEditCaller, show: ShowEditTarget): ShowEditDecision => {
  if (show.end_time !== null || show.latest_entry_is_show_end) {
    return caller.canManageFlowsheet
      ? { allowed: true }
      : {
          allowed: false,
          status: 403,
          message: 'Forbidden: this show has ended; only a music director or station manager may edit it',
          code: 'closed_show',
        };
  }
  return show.dj_ids.includes(caller.id)
    ? { allowed: true }
    : { allowed: false, status: 400, message: 'Bad Request: DJ not a member of the show this entry belongs to' };
};
