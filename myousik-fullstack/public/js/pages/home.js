/**
 * Home page: hero "What's Playing?" button, genre chips, stats,
 * Top Picks (most-playlisted songs) and Popular Artists — all from the API.
 */
import { api, query } from '../api.js';
import { h, icon, cover, plural } from '../dom.js';
import { initLayout, toast } from '../layout.js';
import { playSong, togglePlayback, nowPlaying } from '../player.js';

await initLayout();

const heroPlay = document.getElementById('hero-play');
const heroTrack = document.getElementById('hero-track');
heroPlay.append(icon('play'));

let picks = [];

// Load everything in parallel; each section renders independently.
const [songsRes, genresRes, artistsRes] = await Promise.allSettled([
  api(`/api/songs${query({ sort: 'popularity', limit: 6 })}`),
  api('/api/genres'),
  api('/api/artists'),
]);

if (songsRes.status === 'fulfilled') {
  picks = songsRes.value.data;
  renderPicks(picks);
  renderStats(songsRes.value.pagination.total, genresRes.value?.data.length ?? 0, artistsRes.value?.data.length ?? 0);
} else {
  document.getElementById('top-picks').replaceChildren(h('p', { class: 'muted' }, 'Could not load songs right now.'));
}
if (genresRes.status === 'fulfilled') renderGenres(genresRes.value.data);
if (artistsRes.status === 'fulfilled') renderArtists(artistsRes.value.data.slice(0, 10));

// "What's Playing?" — v1 played one hard-coded mp3; now it plays the top pick.
heroPlay.addEventListener('click', () => {
  if (nowPlaying().song) return togglePlayback();
  const song = picks.find((s) => s.audio_url);
  if (!song || !playSong(song)) toast('Nothing to play yet.', { error: true });
});

document.addEventListener('player:change', ({ detail }) => {
  heroPlay.replaceChildren(icon(detail.playing ? 'pause' : 'play'));
  heroPlay.setAttribute('aria-label', detail.playing ? 'Pause' : 'Play a lo-fi track');
  heroTrack.textContent = detail.song ? `${detail.song.title} — ${detail.song.artist}` : 'Tap play for a lo-fi loop';
});

function renderPicks(songs) {
  const grid = document.getElementById('top-picks');
  grid.removeAttribute('aria-busy');
  grid.replaceChildren(...songs.map((song) => h('article', { class: 'song-card' },
    h('div', { class: 'cover-wrap' },
      cover(song),
      song.audio_url && h('button', {
        type: 'button', class: 'play-btn', 'aria-label': `Play ${song.title} by ${song.artist}`, onclick: () => playSong(song),
      }, icon('play'))),
    h('h3', {}, song.title),
    h('p', {}, song.artist))));
}

function renderGenres(genres) {
  document.getElementById('genre-chips').replaceChildren(...genres.map((g) => h('li', {},
    h('a', { class: 'chip', href: `/library${query({ genre: g.genre })}` },
      g.genre, h('span', { class: 'count' }, g.song_count)))));
}

function renderArtists(artists) {
  document.getElementById('artists').replaceChildren(...artists.map((a) => h('li', { class: 'artist' },
    h('a', { href: `/library${query({ q: a.artist })}` },
      cover({ title: a.artist, cover_url: a.cover_url }),
      h('strong', {}, a.artist),
      h('span', {}, plural(a.song_count, 'song'))))));
}

function renderStats(songs, genres, artists) {
  const stat = (n, label) => h('div', { class: 'stat' }, h('strong', {}, n), h('span', {}, label));
  document.getElementById('stats').replaceChildren(stat(songs, 'songs'), stat(artists, 'artists'), stat(genres, 'genres'));
}
