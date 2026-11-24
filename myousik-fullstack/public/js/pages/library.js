/**
 * Library page: searchable, sortable, paginated song table with
 * add / edit / delete dialogs (for the song's owner) and "add to playlist".
 * Filter state lives in the URL so results can be bookmarked and shared.
 */
import { api, query } from '../api.js';
import { h, icon, iconButton, cover, formatDuration, debounce, plural } from '../dom.js';
import { initLayout, toast, loginUrl } from '../layout.js';
import { playSong } from '../player.js';
import { validateForm, showApiError, clearErrors, withBusy } from '../forms.js';
import { schemas } from '../shared/validation.js';

const PAGE_SIZE = 10;
const user = await initLayout();

const $ = (id) => document.getElementById(id);
const filters = $('filters');
const rows = $('song-rows');
const status = $('status');
const songDialog = $('song-dialog');
const songForm = $('song-form');
const deleteDialog = $('delete-dialog');
const playlistDialog = $('playlist-dialog');

$('search-icon').append(icon('search'));
document.querySelectorAll('[data-close]').forEach((btn) => {
  if (!btn.textContent.trim()) btn.append(icon('close'));
  btn.addEventListener('click', () => btn.closest('dialog').close());
});

// ---- State <-> URL -------------------------------------------------------
const params = new URLSearchParams(location.search);
const state = {
  q: params.get('q') || '',
  genre: params.get('genre') || '',
  sort: params.get('sort') || 'title',
  order: params.get('order') || '',
  page: Math.max(1, Number(params.get('page')) || 1),
};
let lastResult = null;

filters.elements.q.value = state.q;
const sortSelect = filters.elements.sort;
const sortValue = `${state.sort}:${state.order || (['popularity', 'created_at', 'year'].includes(state.sort) ? 'desc' : 'asc')}`;
if ([...sortSelect.options].some((o) => o.value === sortValue)) sortSelect.value = sortValue;

function syncUrl() {
  const [sort, order] = sortSelect.value.split(':');
  const qs = query({ q: state.q, genre: state.genre, sort: sort === 'title' ? '' : sort, order: sort === 'title' ? '' : order, page: state.page > 1 ? state.page : '' });
  history.replaceState(null, '', `/library${qs}`);
}

// ---- Toolbar -------------------------------------------------------------
$('add-slot').append(user
  ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openSongDialog() }, icon('plus'), 'Add song')
  : h('a', { class: 'btn btn-secondary', href: loginUrl() }, 'Log in to add songs'));

filters.addEventListener('submit', (e) => e.preventDefault());
filters.elements.q.addEventListener('input', debounce(() => {
  state.q = filters.elements.q.value.trim();
  state.page = 1;
  load();
}, 250));
filters.elements.genre.addEventListener('change', () => {
  state.genre = filters.elements.genre.value;
  state.page = 1;
  load();
});
sortSelect.addEventListener('change', () => {
  state.page = 1;
  load();
});
$('prev').addEventListener('click', () => { state.page -= 1; load(); });
$('next').addEventListener('click', () => { state.page += 1; load(); });

// Genres for the filter and the form's suggestions.
api('/api/genres').then(({ data }) => {
  for (const { genre } of data) {
    filters.elements.genre.append(h('option', { value: genre }, genre));
    $('genre-list').append(h('option', { value: genre }));
  }
  filters.elements.genre.value = state.genre;
}).catch(() => {});

// ---- Loading & rendering -------------------------------------------------
async function load() {
  const [sort, order] = sortSelect.value.split(':');
  syncUrl();
  status.textContent = 'Loading…';
  try {
    lastResult = await api(`/api/songs${query({ q: state.q, genre: state.genre, sort, order, page: state.page, limit: PAGE_SIZE })}`);
    render(lastResult);
  } catch (err) {
    status.textContent = err.message;
  }
}

function render({ data, pagination }) {
  const { page, total, total_pages: pages } = pagination;
  if (page > pages && total > 0) {
    state.page = pages;
    load();
    return;
  }
  const filtered = state.q || state.genre;
  status.textContent = total
    ? `${plural(total, 'song')}${filtered ? ' match your search' : ''}.`
    : 'No songs match your search.';
  $('page-info').textContent = total ? `Page ${page} of ${pages}` : '';
  $('prev').disabled = page <= 1;
  $('next').disabled = page >= pages;

  rows.replaceChildren(...data.map((song, i) => songRow(song, (page - 1) * PAGE_SIZE + i + 1)));
  if (!data.length) {
    rows.append(h('tr', {}, h('td', { colspan: '7' }, h('div', { class: 'empty-state' },
      h('h3', {}, 'Nothing here yet'),
      h('p', {}, filtered ? 'Try a different search or genre.' : 'Add the first song to the library.')))));
  }
}

function songRow(song, n) {
  const owns = user && song.created_by === user.id;
  const actions = [];
  if (song.audio_url) actions.push(iconButton('play', `Play ${song.title}`, () => playSong(song)));
  if (user) actions.push(iconButton('list', `Add ${song.title} to a playlist`, () => openPlaylistPicker(song)));
  if (owns) {
    actions.push(iconButton('edit', `Edit ${song.title}`, () => openSongDialog(song)));
    actions.push(iconButton('trash', `Delete ${song.title}`, () => confirmDelete(song), 'danger'));
  }
  return h('tr', {},
    h('td', { class: 'num' }, n),
    h('td', {}, h('div', { class: 'track' }, cover(song), h('div', {}, h('strong', {}, song.title), h('span', {}, song.artist)))),
    h('td', { class: 'col-album muted-cell' }, song.album || '—'),
    h('td', { class: 'col-genre' }, song.genre ? h('span', { class: 'genre-tag' }, song.genre) : '—'),
    h('td', { class: 'col-year muted-cell' }, song.year ?? '—'),
    h('td', { class: 'col-length' }, formatDuration(song.duration_sec)),
    h('td', { class: 'col-actions' }, actions));
}

// ---- Add / edit ----------------------------------------------------------
let editing = null;

function openSongDialog(song = null) {
  editing = song;
  songForm.reset();
  clearErrors(songForm);
  $('song-dialog-title').textContent = song ? 'Edit song' : 'Add a song';
  $('song-submit').textContent = song ? 'Save changes' : 'Add song';
  if (song) {
    for (const name of ['title', 'artist', 'album', 'genre', 'duration_sec', 'year', 'cover_url', 'audio_url']) {
      songForm.elements[name].value = song[name] ?? '';
    }
  }
  songDialog.showModal();
  songForm.elements.title.focus();
}

songForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = validateForm(songForm, schemas.song); // same rules the server applies
  if (!values) return;
  await withBusy($('song-submit'), async () => {
    try {
      const { song } = editing
        ? await api(`/api/songs/${editing.id}`, { method: 'PUT', body: values })
        : await api('/api/songs', { method: 'POST', body: values });
      songDialog.close();
      toast(editing ? `Saved "${song.title}".` : `Added "${song.title}" to the library.`);
      await load();
    } catch (err) {
      showApiError(songForm, err); // server-side field errors land next to the fields
    }
  });
});

// ---- Delete --------------------------------------------------------------
let deleting = null;
function confirmDelete(song) {
  deleting = song;
  $('delete-text').textContent = `"${song.title}" by ${song.artist} will be removed from the library and from every playlist. This can't be undone.`;
  deleteDialog.showModal();
}
$('delete-confirm').addEventListener('click', async () => {
  try {
    await api(`/api/songs/${deleting.id}`, { method: 'DELETE' });
    deleteDialog.close();
    toast(`Deleted "${deleting.title}".`);
    await load();
  } catch (err) {
    deleteDialog.close();
    toast(err.message, { error: true });
  }
});

// ---- Add to playlist -----------------------------------------------------
async function openPlaylistPicker(song) {
  $('playlist-dialog-song').textContent = `${song.title} — ${song.artist}`;
  const list = $('playlist-options');
  list.replaceChildren(h('li', { class: 'muted' }, 'Loading your playlists…'));
  playlistDialog.showModal();
  try {
    const { data } = await api('/api/playlists');
    if (!data.length) {
      list.replaceChildren(h('li', { class: 'muted' }, "You don't have any playlists yet."));
      return;
    }
    list.replaceChildren(...data.map((p) => h('li', {},
      h('button', {
        type: 'button',
        onclick: async () => {
          try {
            await api(`/api/playlists/${p.id}/songs`, { method: 'POST', body: { song_id: song.id } });
            toast(`Added to "${p.name}".`);
            playlistDialog.close();
          } catch (err) {
            toast(err.status === 409 ? `Already in "${p.name}".` : err.message, { error: true });
          }
        },
      }, p.name, h('span', {}, plural(p.song_count, 'song'))))));
  } catch (err) {
    list.replaceChildren(h('li', { class: 'muted' }, err.message));
  }
}

load();
