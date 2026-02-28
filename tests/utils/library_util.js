/**
 * Library test utilities
 * Helper functions for library-related integration tests
 */

const url = `${process.env.TEST_HOST}:${process.env.PORT}`;

/**
 * Creates a new artist in the library.
 *
 * @param {object} artistData - Artist data
 * @param {string} artistData.artist_name - Artist name
 * @param {string} artistData.code_letters - Artist code letters (e.g., 'BUI')
 * @param {number} artistData.genre_id - Genre ID
 * @param {string} access_token - Authorization token
 * @returns {Promise<object>} Created artist
 */
exports.createArtist = async (artistData, access_token) => {
  const res = await fetch(`${url}/library/artists`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: access_token,
    },
    body: JSON.stringify(artistData),
  });

  return res;
};

/**
 * Creates a new album in the library.
 *
 * @param {object} albumData - Album data
 * @param {string} albumData.album_title - Album title
 * @param {number} [albumData.artist_id] - Artist ID
 * @param {string} [albumData.artist_name] - Artist name (if artist_id not provided)
 * @param {string} albumData.label - Record label
 * @param {number} albumData.genre_id - Genre ID
 * @param {number} albumData.format_id - Format ID
 * @param {string} access_token - Authorization token
 * @returns {Promise<object>} Created album
 */
exports.createAlbum = async (albumData, access_token) => {
  const res = await fetch(`${url}/library`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: access_token,
    },
    body: JSON.stringify(albumData),
  });

  return res;
};

/**
 * Creates a new format in the library.
 *
 * @param {object} formatData - Format data
 * @param {string} formatData.name - Format name
 * @param {string} access_token - Authorization token
 * @returns {Promise<object>} Created format
 */
exports.createFormat = async (formatData, access_token) => {
  const res = await fetch(`${url}/library/formats`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: access_token,
    },
    body: JSON.stringify(formatData),
  });

  return res;
};

/**
 * Creates a new genre in the library.
 *
 * @param {object} genreData - Genre data
 * @param {string} genreData.name - Genre name
 * @param {string} genreData.description - Genre description
 * @param {string} access_token - Authorization token
 * @returns {Promise<object>} Created genre
 */
exports.createGenre = async (genreData, access_token) => {
  const res = await fetch(`${url}/library/genres`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: access_token,
    },
    body: JSON.stringify(genreData),
  });

  return res;
};

/**
 * Adds an album to rotation.
 *
 * @param {object} rotationData - Rotation data
 * @param {number} rotationData.album_id - Album ID
 * @param {string} rotationData.rotation_bin - Play frequency (S, L, M, H)
 * @param {string} access_token - Authorization token
 * @returns {Promise<object>} Created rotation entry
 */
exports.addToRotation = async (rotationData, access_token) => {
  const res = await fetch(`${url}/library/rotation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: access_token,
    },
    body: JSON.stringify(rotationData),
  });

  return res;
};

/**
 * Kills a rotation entry.
 *
 * @param {object} killData - Kill data
 * @param {number} killData.rotation_id - Rotation ID
 * @param {string} [killData.kill_date] - Kill date (YYYY-MM-DD format)
 * @param {string} access_token - Authorization token
 * @returns {Promise<object>} Updated rotation entry
 */
exports.killRotation = async (killData, access_token) => {
  const res = await fetch(`${url}/library/rotation`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: access_token,
    },
    body: JSON.stringify(killData),
  });

  return res;
};

/**
 * Gets album info by ID.
 *
 * @param {number} album_id - Album ID
 * @param {string} access_token - Authorization token
 * @returns {Promise<object>} Album info
 */
exports.getAlbumInfo = async (album_id, access_token) => {
  const res = await fetch(`${url}/library/info?album_id=${album_id}`, {
    method: 'GET',
    headers: {
      Authorization: access_token,
    },
  });

  return res;
};

/**
 * Searches the library with DJ auth.
 *
 * @param {object} searchParams - Search parameters
 * @param {string} [searchParams.artist_name] - Artist name
 * @param {string} [searchParams.album_title] - Album title
 * @param {number} [searchParams.n] - Number of results
 * @param {string} access_token - Authorization token
 * @returns {Promise<object>} Search results
 */
exports.searchLibrary = async (searchParams, access_token) => {
  const params = new URLSearchParams();
  if (searchParams.artist_name) params.append('artist_name', searchParams.artist_name);
  if (searchParams.album_title) params.append('album_title', searchParams.album_title);
  if (searchParams.n) params.append('n', searchParams.n.toString());

  const res = await fetch(`${url}/library?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: access_token,
    },
  });

  return res;
};
