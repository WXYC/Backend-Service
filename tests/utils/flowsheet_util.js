// This function is assuming the /flowsheet/join enpoint is working properly
const url = `${process.env.TEST_HOST}:${process.env.PORT}`;

exports.join_show = async (dj_id, access_token) => {
  const res = await fetch(`${url}/flowsheet/join`, {
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
