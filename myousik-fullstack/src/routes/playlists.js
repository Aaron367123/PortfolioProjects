/**
 * /api/playlists — each user's private playlists and their ordered songs.
 *
 * Every route requires a login, and every route that touches a specific
 * playlist checks ownership first (403 if it belongs to someone else).
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { check, parseId, schemas } from '../validation.js';
import { transaction } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { SONG_SELECT } from './songs.js';

const PLAYLIST_SELECT = `
  p.id, p.user_id, p.name, p.description, p.created_at, p.updated_at,
  (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id) AS song_count,
  (SELECT COALESCE(SUM(s.duration_sec), 0) FROM playlist_songs ps JOIN songs s ON s.id = ps.song_id
    WHERE ps.playlist_id = p.id) AS total_duration_sec`;

export function playlistsRouter({ db }) {
  const router = Router();
  router.use(requireAuth);

  const listMine = db.prepare(`SELECT ${PLAYLIST_SELECT} FROM playlists p WHERE p.user_id = ? ORDER BY p.updated_at DESC, p.id DESC`);
  const getPlaylist = db.prepare(`SELECT ${PLAYLIST_SELECT} FROM playlists p WHERE p.id = ?`);
  const getSongs = db.prepare(`
    SELECT ps.position, ps.added_at, ${SONG_SELECT}
    FROM playlist_songs ps
    JOIN songs s ON s.id = ps.song_id
    LEFT JOIN users u ON u.id = s.created_by
    WHERE ps.playlist_id = ?
    ORDER BY ps.position, ps.added_at`);
  const insertPlaylist = db.prepare('INSERT INTO playlists (user_id, name, description) VALUES (?, ?, ?)');
  const touch = db.prepare("UPDATE playlists SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?");
  const deletePlaylist = db.prepare('DELETE FROM playlists WHERE id = ?');
  const songExists = db.prepare('SELECT 1 FROM songs WHERE id = ?');
  const entryExists = db.prepare('SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND song_id = ?');
  const nextPosition = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS pos FROM playlist_songs WHERE playlist_id = ?');
  const insertEntry = db.prepare('INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)');
  const deleteEntry = db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?');
  const orderedSongIds = db.prepare('SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position, added_at');
  const setPosition = db.prepare('UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND song_id = ?');

  /** Load a playlist the current user owns: 404 if missing, 403 if not theirs. */
  const loadOwned = (req) => {
    const playlist = getPlaylist.get(parseId(req.params.id, 'Playlist'));
    if (!playlist) throw notFound('Playlist');
    if (playlist.user_id !== req.user.id) throw forbidden('That playlist belongs to another user.');
    return playlist;
  };

  /** Playlist with its songs, re-read after any change. */
  const detail = (id) => ({ playlist: { ...getPlaylist.get(id), songs: getSongs.all(id) } });

  /** Rewrite positions as 0..n-1 in the given order (call inside a transaction). */
  const writeOrder = (playlistId, songIds) => {
    songIds.forEach((songId, index) => setPosition.run(index, playlistId, songId));
    touch.run(playlistId);
  };

  router.get('/', (req, res) => {
    res.json({ data: listMine.all(req.user.id) });
  });

  router.post('/', (req, res) => {
    const { name, description } = check(req.body, schemas.playlist);
    const { lastInsertRowid } = insertPlaylist.run(req.user.id, name, description);
    res.status(201).location(`/api/playlists/${lastInsertRowid}`).json(detail(lastInsertRowid));
  });

  router.get('/:id', (req, res) => {
    res.json(detail(loadOwned(req).id));
  });

  router.patch('/:id', (req, res) => {
    const playlist = loadOwned(req);
    const changes = check(req.body, schemas.playlist, { partial: true });
    const fields = ['name', 'description'].filter((f) => f in changes);
    if (fields.length) {
      const setSql = fields.map((f) => `${f} = :${f}`).join(', ');
      db.prepare(`UPDATE playlists SET ${setSql}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = :id`)
        .run({ ...Object.fromEntries(fields.map((f) => [f, changes[f]])), id: playlist.id });
    }
    res.json(detail(playlist.id));
  });

  router.delete('/:id', (req, res) => {
    deletePlaylist.run(loadOwned(req).id); // entries cascade
    res.status(204).end();
  });

  // Add a song to the end of the playlist.
  router.post('/:id/songs', (req, res) => {
    const playlist = loadOwned(req);
    const { song_id: songId } = check(req.body, schemas.playlistAddSong);
    if (!songExists.get(songId)) throw notFound('Song');
    if (entryExists.get(playlist.id, songId)) {
      throw conflict('That song is already in this playlist.', { song_id: 'Already in this playlist.' });
    }
    transaction(db, () => {
      insertEntry.run(playlist.id, songId, nextPosition.get(playlist.id).pos);
      touch.run(playlist.id);
    });
    res.status(201).json(detail(playlist.id));
  });

  // Remove a song, then close the gap so positions stay 0..n-1.
  router.delete('/:id/songs/:songId', (req, res) => {
    const playlist = loadOwned(req);
    const songId = parseId(req.params.songId, 'Song');
    transaction(db, () => {
      if (deleteEntry.run(playlist.id, songId).changes === 0) throw notFound('Song in this playlist');
      writeOrder(playlist.id, orderedSongIds.all(playlist.id).map((r) => r.song_id));
    });
    res.json(detail(playlist.id));
  });

  // Reorder: the client sends the complete new order of song ids.
  // It must be an exact permutation of the current songs, so a stale client
  // can't silently drop or duplicate entries.
  router.put('/:id/songs/order', (req, res) => {
    const playlist = loadOwned(req);
    const { song_ids: newOrder } = check(req.body, schemas.playlistOrder);
    transaction(db, () => {
      const current = orderedSongIds.all(playlist.id).map((r) => r.song_id);
      const sameSet = newOrder.length === current.length && newOrder.every((id) => current.includes(id));
      if (!sameSet) {
        throw badRequest('Order must list every song in the playlist exactly once.', {
          song_ids: 'Must contain exactly the songs currently in the playlist.',
        });
      }
      writeOrder(playlist.id, newOrder);
    });
    res.json(detail(playlist.id));
  });

  return router;
}
