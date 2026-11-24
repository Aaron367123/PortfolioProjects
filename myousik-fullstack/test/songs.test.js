import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, songPayload, DEMO_PASSWORD } from './helpers.js';
import { DEMO_SONGS } from '../src/db/seed.js';

describe('songs', () => {
  let srv;
  let alice;
  let bob;
  before(async () => {
    srv = await startServer({ seed: true });
    alice = srv.client();
    await alice.register('alice');
    bob = srv.client();
    await bob.register('bob');
  });
  after(() => srv.close());

  describe('listing (public)', () => {
    it('lists songs with pagination metadata, no login needed', async () => {
      const res = await srv.client().get('/api/songs?limit=5&page=2&sort=title');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 5);
      assert.deepEqual(res.body.pagination, {
        page: 2, limit: 5, total: DEMO_SONGS.length, total_pages: Math.ceil(DEMO_SONGS.length / 5),
      });
      const titles = (await srv.client().get('/api/songs?limit=100&sort=title')).body.data.map((s) => s.title);
      assert.deepEqual(res.body.data.map((s) => s.title), titles.slice(5, 10));
    });

    it('sorts by a whitelisted column in either direction', async () => {
      const asc = (await srv.client().get('/api/songs?sort=duration_sec&order=asc&limit=100')).body.data;
      const durations = asc.map((s) => s.duration_sec);
      assert.deepEqual(durations, [...durations].sort((a, b) => a - b));
      const desc = (await srv.client().get('/api/songs?sort=duration_sec&order=desc&limit=1')).body.data;
      assert.equal(desc[0].duration_sec, Math.max(...durations));
    });

    it('searches title, artist, album and genre with ?q=', async () => {
      const byArtist = await srv.client().get('/api/songs?q=sol%20ferreira');
      assert.equal(byArtist.body.pagination.total, 3);
      assert.ok(byArtist.body.data.every((s) => s.artist === 'Sol Ferreira Trio'));

      const byAlbum = await srv.client().get('/api/songs?q=city%20colours');
      assert.equal(byAlbum.body.pagination.total, 2);

      const genre = await srv.client().get('/api/songs?genre=jazz');
      assert.equal(genre.body.pagination.total, 3);
    });

    it('treats search input as data, not SQL or wildcards', async () => {
      const injection = await srv.client().get(`/api/songs?q=${encodeURIComponent("' OR 1=1 --")}`);
      assert.equal(injection.status, 200);
      assert.equal(injection.body.pagination.total, 0);

      const wildcard = await srv.client().get('/api/songs?q=%25'); // a literal "%"
      assert.equal(wildcard.body.pagination.total, 0);
    });

    it('rejects bad query parameters with 400', async () => {
      const res = await srv.client().get('/api/songs?sort=password_hash&limit=1000&page=0');
      assert.equal(res.status, 400);
      assert.deepEqual(Object.keys(res.body.error.fields).sort(), ['limit', 'page', 'sort']);
    });

    it('gets one song, 404 for unknown or malformed ids', async () => {
      const ok = await srv.client().get('/api/songs/1');
      assert.equal(ok.status, 200);
      assert.equal(ok.body.song.title, DEMO_SONGS[0].title);
      assert.equal((await srv.client().get('/api/songs/9999')).status, 404);
      assert.equal((await srv.client().get('/api/songs/abc')).status, 404);
    });
  });

  describe('writes', () => {
    it('requires a login to create, update or delete (401)', async () => {
      const anon = srv.client();
      assert.equal((await anon.post('/api/songs', songPayload())).status, 401);
      assert.equal((await anon.patch('/api/songs/1', { title: 'x' })).status, 401);
      assert.equal((await anon.put('/api/songs/1', songPayload())).status, 401);
      assert.equal((await anon.delete('/api/songs/1')).status, 401);
    });

    it('validates new songs and reports every bad field', async () => {
      const res = await alice.post('/api/songs', {
        title: '', artist: 'x'.repeat(121), duration_sec: 'three minutes', year: 1800, cover_url: 'javascript:alert(1)',
      });
      assert.equal(res.status, 400);
      assert.deepEqual(Object.keys(res.body.error.fields).sort(), ['artist', 'cover_url', 'duration_sec', 'title', 'year']);
      assert.equal(res.body.error.fields.title, 'Title is required.');
    });

    it('full CRUD lifecycle for the owner', async () => {
      const created = await alice.post('/api/songs', songPayload({ title: '  Padded Title  ', cover_url: '/images/covers/cassette.jpg' }));
      assert.equal(created.status, 201);
      const { song } = created.body;
      assert.equal(song.title, 'Padded Title', 'strings are trimmed');
      assert.equal(song.created_by_username, 'alice');
      assert.equal(created.headers.get('location'), `/api/songs/${song.id}`);

      const patched = await alice.patch(`/api/songs/${song.id}`, { genre: 'Jazz', year: null });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.song.genre, 'Jazz');
      assert.equal(patched.body.song.year, null);
      assert.equal(patched.body.song.title, 'Padded Title', 'PATCH leaves other fields alone');

      const put = await alice.put(`/api/songs/${song.id}`, { title: 'Replaced', artist: 'New Artist', duration_sec: 99 });
      assert.equal(put.status, 200);
      assert.equal(put.body.song.album, null, 'PUT replaces the whole resource');

      const badPut = await alice.put(`/api/songs/${song.id}`, { title: 'Only a title' });
      assert.equal(badPut.status, 400);
      assert.ok(badPut.body.error.fields.artist && badPut.body.error.fields.duration_sec);

      assert.equal((await alice.delete(`/api/songs/${song.id}`)).status, 204);
      assert.equal((await alice.get(`/api/songs/${song.id}`)).status, 404);
    });

    it("forbids editing or deleting someone else's song (403)", async () => {
      const { song } = (await alice.post('/api/songs', songPayload({ title: "Alice's Song" }))).body;
      const patch = await bob.patch(`/api/songs/${song.id}`, { title: 'Hijacked' });
      assert.equal(patch.status, 403);
      assert.equal(patch.body.error.code, 'FORBIDDEN');
      assert.equal((await bob.delete(`/api/songs/${song.id}`)).status, 403);
      assert.equal((await srv.client().get(`/api/songs/${song.id}`)).body.song.title, "Alice's Song");
    });

    it('lets the demo user edit the seeded songs', async () => {
      const demo = srv.client();
      assert.equal((await demo.login('demo', DEMO_PASSWORD)).status, 200);
      const res = await demo.patch('/api/songs/2', { year: 2025 });
      assert.equal(res.status, 200);
      assert.equal(res.body.song.year, 2025);
    });
  });

  it('serves genre and artist summaries for the home page', async () => {
    const genres = (await srv.client().get('/api/genres')).body.data;
    assert.ok(genres.find((g) => g.genre === 'Jazz' && g.song_count >= 3));
    const artists = (await srv.client().get('/api/artists')).body.data;
    assert.ok(artists.length > 0 && artists.length <= 50);
    assert.ok('cover_url' in artists[0] && 'song_count' in artists[0]);
  });
});
