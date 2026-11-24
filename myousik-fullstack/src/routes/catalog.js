/**
 * Read-only summaries derived from the songs table, used by the home page:
 *   GET /api/genres   -> genres with song counts
 *   GET /api/artists  -> artists with song counts and a representative cover
 */
import { Router } from 'express';

export function catalogRouter({ db }) {
  const router = Router();

  const genres = db.prepare(`
    SELECT genre, COUNT(*) AS song_count
    FROM songs WHERE genre IS NOT NULL
    GROUP BY genre COLLATE NOCASE
    ORDER BY song_count DESC, genre COLLATE NOCASE`);

  // MIN(cover_url) picks one cover deterministically; the popularity column
  // counts how many playlist entries reference the artist's songs.
  const artists = db.prepare(`
    SELECT s.artist, COUNT(DISTINCT s.id) AS song_count, MIN(s.cover_url) AS cover_url,
           COUNT(ps.song_id) AS playlist_entries
    FROM songs s LEFT JOIN playlist_songs ps ON ps.song_id = s.id
    GROUP BY s.artist COLLATE NOCASE
    ORDER BY playlist_entries DESC, song_count DESC, s.artist COLLATE NOCASE
    LIMIT 50`);

  router.get('/genres', (_req, res) => res.json({ data: genres.all() }));
  router.get('/artists', (_req, res) => res.json({ data: artists.all() }));

  return router;
}
