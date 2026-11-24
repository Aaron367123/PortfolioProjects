/**
 * /api/songs — the shared music library.
 *
 * Reads are public. Creating requires a login; editing/deleting is limited to
 * the user who added the song (seeded songs belong to the demo account).
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { check, parseId, schemas } from '../validation.js';
import { forbidden, notFound } from '../errors.js';

/** Columns returned for a song everywhere in the API (also used by playlists). */
export const SONG_SELECT = `
  s.id, s.title, s.artist, s.album, s.genre, s.duration_sec, s.year,
  s.cover_url, s.audio_url, s.created_by, u.username AS created_by_username,
  s.created_at, s.updated_at,
  (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.song_id = s.id) AS playlist_count`;

// Whitelisted ORDER BY expressions — user input never reaches the SQL text.
const SORT_SQL = {
  title: 's.title COLLATE NOCASE',
  artist: 's.artist COLLATE NOCASE',
  year: 's.year',
  duration_sec: 's.duration_sec',
  created_at: 's.created_at',
  popularity: 'playlist_count',
};

const SONG_FIELDS = ['title', 'artist', 'album', 'genre', 'duration_sec', 'year', 'cover_url', 'audio_url'];

/** Escape LIKE wildcards so a search for "100%" means the literal text. */
const likePattern = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function songsRouter({ db }) {
  const router = Router();

  const getSong = db.prepare(`SELECT ${SONG_SELECT} FROM songs s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?`);
  const insertSong = db.prepare(`
    INSERT INTO songs (title, artist, album, genre, duration_sec, year, cover_url, audio_url, created_by)
    VALUES (:title, :artist, :album, :genre, :duration_sec, :year, :cover_url, :audio_url, :created_by)`);
  const deleteSong = db.prepare('DELETE FROM songs WHERE id = ?');

  /** Load a song or 404; optionally insist the current user owns it. */
  const loadSong = (req, { mustOwn = false } = {}) => {
    const song = getSong.get(parseId(req.params.id, 'Song'));
    if (!song) throw notFound('Song');
    if (mustOwn && song.created_by !== req.user.id) throw forbidden('You can only change songs you added.');
    return song;
  };

  // GET /api/songs?q=&genre=&sort=&order=&page=&limit=
  router.get('/', (req, res) => {
    const query = check(req.query, schemas.songQuery);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sort = query.sort ?? 'title';
    const order = (query.order ?? (sort === 'popularity' || sort === 'created_at' ? 'desc' : 'asc')).toUpperCase();

    const where = [];
    const params = {};
    if (query.q) {
      where.push(`(s.title LIKE :q ESCAPE '\\' OR s.artist LIKE :q ESCAPE '\\'
                   OR s.album LIKE :q ESCAPE '\\' OR s.genre LIKE :q ESCAPE '\\')`);
      params.q = likePattern(query.q);
    }
    if (query.genre) {
      where.push('s.genre = :genre COLLATE NOCASE');
      params.genre = query.genre;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM songs s ${whereSql}`).get(params);
    const data = db.prepare(`
      SELECT ${SONG_SELECT}
      FROM songs s LEFT JOIN users u ON u.id = s.created_by
      ${whereSql}
      ORDER BY ${SORT_SQL[sort]} ${order}, s.id ${order}
      LIMIT :limit OFFSET :offset`).all({ ...params, limit, offset: (page - 1) * limit });

    res.json({
      data,
      pagination: { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) },
    });
  });

  router.get('/:id', (req, res) => {
    res.json({ song: loadSong(req) });
  });

  router.post('/', requireAuth, (req, res) => {
    const song = check(req.body, schemas.song);
    const { lastInsertRowid } = insertSong.run({ ...song, created_by: req.user.id });
    res.status(201).location(`/api/songs/${lastInsertRowid}`).json({ song: getSong.get(lastInsertRowid) });
  });

  // PUT replaces every field (omitted optional fields become null);
  // PATCH changes only the fields that were sent.
  const update = (partial) => (req, res) => {
    const song = loadSong(req, { mustOwn: true });
    const changes = check(req.body, schemas.song, { partial });
    const fields = SONG_FIELDS.filter((f) => f in changes);
    if (fields.length) {
      const setSql = fields.map((f) => `${f} = :${f}`).join(', ');
      db.prepare(`UPDATE songs SET ${setSql}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = :id`)
        .run({ ...pick(changes, fields), id: song.id });
    }
    res.json({ song: getSong.get(song.id) });
  };
  router.put('/:id', requireAuth, update(false));
  router.patch('/:id', requireAuth, update(true));

  router.delete('/:id', requireAuth, (req, res) => {
    const song = loadSong(req, { mustOwn: true });
    deleteSong.run(song.id); // playlist_songs rows go with it (ON DELETE CASCADE)
    res.status(204).end();
  });

  return router;
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}
