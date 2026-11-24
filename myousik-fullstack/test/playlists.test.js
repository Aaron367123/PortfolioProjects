import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, songPayload } from './helpers.js';

describe('playlists', () => {
  let srv;
  let owner;
  let intruder;
  let songIds;

  before(async () => {
    srv = await startServer();
    owner = srv.client();
    await owner.register('owner');
    intruder = srv.client();
    await intruder.register('intruder');
    songIds = [];
    for (const title of ['One', 'Two', 'Three', 'Four']) {
      songIds.push((await owner.post('/api/songs', songPayload({ title }))).body.song.id);
    }
  });
  after(() => srv.close());

  const titles = (res) => res.body.playlist.songs.map((s) => s.title);
  const positions = (res) => res.body.playlist.songs.map((s) => s.position);

  const newPlaylist = async (name = 'Road Trip') => {
    const res = await owner.post('/api/playlists', { name, description: 'Songs for the car' });
    assert.equal(res.status, 201);
    return res.body.playlist.id;
  };

  it('requires a login (401)', async () => {
    const anon = srv.client();
    assert.equal((await anon.get('/api/playlists')).status, 401);
    assert.equal((await anon.post('/api/playlists', { name: 'x' })).status, 401);
  });

  it('creates, lists (own only), renames and deletes playlists', async () => {
    const id = await newPlaylist('Gym Mix');

    const mine = (await owner.get('/api/playlists')).body.data;
    assert.ok(mine.some((p) => p.id === id && p.name === 'Gym Mix' && p.song_count === 0));
    const theirs = (await intruder.get('/api/playlists')).body.data;
    assert.equal(theirs.length, 0, "other users don't see my playlists");

    const renamed = await owner.patch(`/api/playlists/${id}`, { name: 'Gym Mix 2' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.playlist.name, 'Gym Mix 2');
    assert.equal(renamed.body.playlist.description, 'Songs for the car');

    assert.equal((await owner.delete(`/api/playlists/${id}`)).status, 204);
    assert.equal((await owner.get(`/api/playlists/${id}`)).status, 404);
  });

  it('validates playlist names', async () => {
    const res = await owner.post('/api/playlists', { name: '   ', description: 'x'.repeat(300) });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.body.error.fields).sort(), ['description', 'name']);
  });

  it("returns 403 for every attempt to read or change someone else's playlist", async () => {
    const id = await newPlaylist('Private');
    await owner.post(`/api/playlists/${id}/songs`, { song_id: songIds[0] });

    const attempts = [
      intruder.get(`/api/playlists/${id}`),
      intruder.patch(`/api/playlists/${id}`, { name: 'Mine now' }),
      intruder.delete(`/api/playlists/${id}`),
      intruder.post(`/api/playlists/${id}/songs`, { song_id: songIds[1] }),
      intruder.delete(`/api/playlists/${id}/songs/${songIds[0]}`),
      intruder.put(`/api/playlists/${id}/songs/order`, { song_ids: [songIds[0]] }),
    ];
    for (const res of await Promise.all(attempts)) {
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    }
    const after = await owner.get(`/api/playlists/${id}`);
    assert.equal(after.body.playlist.name, 'Private');
    assert.deepEqual(titles(after), ['One']);
  });

  it('adds songs in order and rejects duplicates (409) and unknown songs (404)', async () => {
    const id = await newPlaylist();
    for (const songId of songIds.slice(0, 3)) {
      assert.equal((await owner.post(`/api/playlists/${id}/songs`, { song_id: songId })).status, 201);
    }
    const res = await owner.get(`/api/playlists/${id}`);
    assert.deepEqual(titles(res), ['One', 'Two', 'Three']);
    assert.deepEqual(positions(res), [0, 1, 2]);
    assert.equal(res.body.playlist.song_count, 3);
    assert.equal(res.body.playlist.total_duration_sec, 540);

    const dup = await owner.post(`/api/playlists/${id}/songs`, { song_id: songIds[0] });
    assert.equal(dup.status, 409);
    assert.equal((await owner.post(`/api/playlists/${id}/songs`, { song_id: 99999 })).status, 404);
    assert.equal((await owner.post(`/api/playlists/${id}/songs`, { song_id: 'one' })).status, 400);
  });

  it('reorders with a full permutation and rejects anything else', async () => {
    const id = await newPlaylist();
    for (const songId of songIds) await owner.post(`/api/playlists/${id}/songs`, { song_id: songId });
    const [one, two, three, four] = songIds;

    const res = await owner.put(`/api/playlists/${id}/songs/order`, { song_ids: [four, one, three, two] });
    assert.equal(res.status, 200);
    assert.deepEqual(titles(res), ['Four', 'One', 'Three', 'Two']);
    assert.deepEqual(positions(res), [0, 1, 2, 3]);

    const missing = await owner.put(`/api/playlists/${id}/songs/order`, { song_ids: [four, one, three] });
    assert.equal(missing.status, 400);
    const dupes = await owner.put(`/api/playlists/${id}/songs/order`, { song_ids: [four, four, one, three] });
    assert.equal(dupes.status, 400);
    const stranger = await owner.put(`/api/playlists/${id}/songs/order`, { song_ids: [four, one, three, 99999] });
    assert.equal(stranger.status, 400);

    assert.deepEqual(titles(await owner.get(`/api/playlists/${id}`)), ['Four', 'One', 'Three', 'Two'], 'failed reorders change nothing');
  });

  it('removes songs and closes the gap in positions', async () => {
    const id = await newPlaylist();
    for (const songId of songIds) await owner.post(`/api/playlists/${id}/songs`, { song_id: songId });

    const res = await owner.delete(`/api/playlists/${id}/songs/${songIds[1]}`);
    assert.equal(res.status, 200);
    assert.deepEqual(titles(res), ['One', 'Three', 'Four']);
    assert.deepEqual(positions(res), [0, 1, 2]);

    assert.equal((await owner.delete(`/api/playlists/${id}/songs/${songIds[1]}`)).status, 404);
  });

  it('drops a song from every playlist when the song itself is deleted', async () => {
    const id = await newPlaylist();
    const { song } = (await owner.post('/api/songs', songPayload({ title: 'Temporary' }))).body;
    await owner.post(`/api/playlists/${id}/songs`, { song_id: songIds[0] });
    await owner.post(`/api/playlists/${id}/songs`, { song_id: song.id });

    assert.equal((await owner.delete(`/api/songs/${song.id}`)).status, 204);
    assert.deepEqual(titles(await owner.get(`/api/playlists/${id}`)), ['One']);
  });
});
