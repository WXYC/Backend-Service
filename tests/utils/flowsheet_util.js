// This function is assuming the /flowsheet/join enpoint is working properly
const url = `${process.env.TEST_HOST}:${process.env.PORT}`;

/**
 * `POST /flowsheet/join`.
 *
 * `body` folds extra request fields in — today `intent` and `expected_show_id`
 * (BS#2233). Callers that send neither get byte-identical behavior to before,
 * which is what keeps every existing spec valid while `FLOWSHEET_TAKEOVER_ENABLED`
 * is off: the flag-off branch ignores both fields and co-hosts as it always did.
 * A spec that turns the flag on and joins a secondary DJ onto an already-open
 * show must now say `{ intent: 'join' }`, or it is a 409.
 */
exports.join_show = async (dj_id, access_token, body = {}) => {
  const res = await fetch(`${url}/flowsheet/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: access_token,
    },
    body: JSON.stringify({
      dj_id: dj_id,
      ...body,
    }),
  });

  return res;
};

exports.leave_show = async (dj_id, access_token) => {
  const res = await fetch(`${url}/flowsheet/end`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: access_token,
    },
    body: JSON.stringify({
      dj_id: dj_id,
    }),
  });

  return res;
};
