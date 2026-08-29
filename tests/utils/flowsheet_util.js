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
 *
 * Throws on a non-2xx response (BS#2309). With the flag off the 409 this
 * guards against cannot occur, so every pre-existing call site that never
 * checked the response stayed valid by construction. With the flag on in the
 * integration environment it can, and a silent 409 used to skip the co-host
 * setup a test's `beforeEach` was relying on, surfacing as a confusing
 * assertion failure several lines later — never at the join that actually
 * failed. Throwing here fails fast, at the join, with the response body that
 * explains why.
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

  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`join_show(${dj_id}) failed: ${res.status} ${bodyText}`);
  }

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
