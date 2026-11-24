/**
 * Playlists page, two views:
 *   /playlists        -> your playlists + "new playlist" form
 *   /playlists?id=12  -> one playlist: play, rename, delete, reorder (up/down),
 *                        remove songs, and search the library to add more.
 */
import { api, query } from '../api.js';
import { h, icon, iconButton, cover, formatDuration, formatLongDuration, debounce, plural } from '../dom.js';
import { initLayout, toast, loginUrl } from '../layout.js';
import { playSong } from '../player.js';
import { validateForm, showApiError, clearErrors, withBusy } from '../forms.js';
import { schemas } from '../shared/validation.js';

const user = await initLayout();
const view = document.getElementById('view');
const hero = document.getElementById('page-hero');
const renameDialog = document.getElementById('rename-dialog');
const renameForm = document.getElementById('rename-form');
const deleteDialog = document.getElementById('delete-dialog');

document.querySelectorAll('[data-close]').forEach((btn) => {
  if (!btn.textContent.trim()) btn.append(icon('close'));
  btn.addEventListener('click', () => btn.closest('dialog').close());
});

const playlistId = new URLSearchParams(location.search).get('id');

if (!user) renderLoggedOut();
else if (playlistId) showPlaylist(playlistId);
else showList();

// ---------------------------------------------------------------------------
function renderLoggedOut() {
  view.replaceChildren(h('div', { class: 'panel empty-state' },
    h('h2', {}, 'Log in to build playlists'),
    h('p', {}, 'Playlists are saved to your account, so you need to be logged in to make one.'),
    h('a', { class: 'btn btn-primary', href: loginUrl() }, 'Log in or create an account')));
}

/** 2×2 cover mosaic from the first four songs (or a placeholder). */
function mosaic(songs = []) {
  const withCovers = songs.filter((s) => s.cover_url);
  if (!songs.length) return h('div', { class: 'mosaic empty', 'aria-hidden': 'true' }, icon('music'));
  if (withCovers.length < 4) return h('div', { class: 'mosaic single', 'aria-hidden': 'true' }, cover(withCovers[0] || songs[0]));
  return h('div', { class: 'mosaic', 'aria-hidden': 'true' }, withCovers.slice(0, 4).map((s) => cover(s)));
}

// ---- List view -----------------------------------------------------------
async function showList() {
  const form = h('form', { class: 'form-grid', id: 'create-form', 'data-prefix': 'new-', novalidate: true },
    h('h2', {}, 'New playlist'),
    h('div', { class: 'form-alert', role: 'alert' }),
    h('div', { class: 'field' },
      h('label', { for: 'new-name' }, 'Name'),
      h('input', { type: 'text', id: 'new-name', name: 'name', maxlength: '60', required: true, placeholder: 'e.g. Rainy Day Jazz', 'aria-describedby': 'new-name-error' }),
      h('p', { class: 'field-error', id: 'new-name-error' })),
    h('div', { class: 'field' },
      h('label', { for: 'new-description' }, 'Description ', h('span', { class: 'optional' }, '(optional)')),
      h('textarea', { id: 'new-description', name: 'description', maxlength: '280', rows: '3', 'aria-describedby': 'new-description-error' }),
      h('p', { class: 'field-error', id: 'new-description-error' })),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create playlist'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = validateForm(form, schemas.playlist);
    if (!values) return;
    await withBusy(form.querySelector('[type=submit]'), async () => {
      try {
        const { playlist } = await api('/api/playlists', { method: 'POST', body: values });
        location.href = `/playlists?id=${playlist.id}`;
      } catch (err) {
        showApiError(form, err);
      }
    });
  });

  const grid = h('ul', { class: 'playlist-grid', 'aria-label': 'Your playlists' });
  view.replaceChildren(h('div', { class: 'playlists-layout' },
    h('div', { class: 'panel' }, form),
    h('div', {}, h('div', { class: 'section-head' }, h('h2', {}, `${user.username}'s playlists`)), grid)));

  try {
    const { data } = await api('/api/playlists');
    if (!data.length) {
      grid.replaceWith(h('div', { class: 'panel empty-state' },
        h('h3', {}, 'No playlists yet'),
        h('p', {}, 'Create one on the left, then add songs from the library.')));
      return;
    }
    // Fetch each playlist's songs for its cover mosaic.
    const details = await Promise.all(data.map((p) => api(`/api/playlists/${p.id}`).then((r) => r.playlist)));
    grid.replaceChildren(...details.map((p) => h('li', { class: 'playlist-card' },
      h('a', { href: `/playlists?id=${p.id}` },
        mosaic(p.songs),
        h('h3', {}, p.name),
        h('p', {}, `${plural(p.song_count, 'song')} · ${formatLongDuration(p.total_duration_sec)}`)))));
  } catch (err) {
    grid.replaceChildren(h('li', { class: 'muted' }, err.message));
  }
}

// ---- Detail view ---------------------------------------------------------
let playlist = null;

async function showPlaylist(id) {
  try {
    ({ playlist } = await api(`/api/playlists/${encodeURIComponent(id)}`));
  } catch (err) {
    view.replaceChildren(h('div', { class: 'panel empty-state' },
      h('h2', {}, err.status === 403 ? "That's not your playlist" : 'Playlist not found'),
      h('p', {}, err.message),
      h('a', { class: 'btn btn-primary', href: '/playlists' }, 'Back to your playlists')));
    return;
  }
  hero.hidden = true;
  document.title = `${playlist.name} · Myousik`;

  const tracks = h('ol', { class: 'track-list', 'aria-label': 'Songs in this playlist' });
  const header = h('div', { class: 'playlist-header' });
  const searchInput = h('input', { type: 'search', id: 'add-search', placeholder: 'Search the library…', autocomplete: 'off' });
  const results = h('ul', { class: 'results', 'aria-label': 'Search results' });

  view.replaceChildren(
    h('a', { class: 'back-link', href: '/playlists' }, icon('back'), 'All playlists'),
    header,
    h('div', { class: 'playlist-detail-layout' },
      h('section', { 'aria-labelledby': 'tracks-title' },
        h('h2', { id: 'tracks-title', class: 'visually-hidden' }, 'Songs'),
        h('div', { class: 'table-wrap' }, tracks)),
      h('section', { class: 'panel add-songs', 'aria-labelledby': 'add-title' },
        h('h2', { id: 'add-title' }, 'Add songs'),
        h('div', { class: 'field' }, h('label', { for: 'add-search', class: 'visually-hidden' }, 'Search the library'), searchInput),
        results)));

  const render = () => {
    renderHeader(header);
    renderTracks(tracks);
    renderResults(results, lastResults);
  };

  let lastResults = [];
  const search = async () => {
    try {
      const { data } = await api(`/api/songs${query({ q: searchInput.value.trim(), limit: 8, sort: 'popularity' })}`);
      lastResults = data;
      renderResults(results, data);
    } catch (err) {
      results.replaceChildren(h('li', { class: 'muted' }, err.message));
    }
  };
  searchInput.addEventListener('input', debounce(search, 250));

  // Every mutation returns the updated playlist; re-render from it.
  const mutate = async (path, options, message) => {
    try {
      ({ playlist } = await api(path, options));
      render();
      if (message) toast(message);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };

  function renderHeader(el) {
    el.replaceChildren(
      mosaic(playlist.songs),
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Playlist'),
        h('h1', {}, playlist.name),
        playlist.description && h('p', { class: 'muted' }, playlist.description),
        h('p', { class: 'meta' }, `${plural(playlist.song_count, 'song')} · ${formatLongDuration(playlist.total_duration_sec)}`),
        h('div', { class: 'actions' },
          h('button', {
            type: 'button', class: 'btn btn-primary', disabled: !playlist.songs.some((s) => s.audio_url),
            onclick: () => playSong(playlist.songs.find((s) => s.audio_url)),
          }, icon('play'), 'Play'),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: openRename }, icon('edit'), 'Rename'),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: openDelete }, icon('trash'), 'Delete'))));
  }

  function renderTracks(list) {
    if (!playlist.songs.length) {
      list.replaceChildren(h('li', { class: 'empty-state' }, h('p', {}, 'No songs yet — search the library to add some.')));
      return;
    }
    const ids = playlist.songs.map((s) => s.id);
    list.replaceChildren(...playlist.songs.map((song, i) => h('li', {},
      h('span', { class: 'pos' }, i + 1),
      h('div', { class: 'track' }, cover(song), h('div', {}, h('strong', {}, song.title), h('span', {}, song.artist))),
      h('span', { class: 'length' }, formatDuration(song.duration_sec)),
      h('div', { class: 'row-actions' },
        song.audio_url && iconButton('play', `Play ${song.title}`, () => playSong(song)),
        withDisabled(iconButton('up', `Move ${song.title} up`, () => move(ids, i, -1)), i === 0),
        withDisabled(iconButton('down', `Move ${song.title} down`, () => move(ids, i, 1)), i === ids.length - 1),
        iconButton('trash', `Remove ${song.title} from playlist`, () => mutate(`/api/playlists/${playlist.id}/songs/${song.id}`, { method: 'DELETE' }, `Removed "${song.title}".`), 'danger')))));
  }

  // Swap with the neighbour and send the complete new order to the server.
  function move(ids, index, delta) {
    const order = [...ids];
    [order[index], order[index + delta]] = [order[index + delta], order[index]];
    mutate(`/api/playlists/${playlist.id}/songs/order`, { method: 'PUT', body: { song_ids: order } });
  }

  function renderResults(list, songs) {
    if (!songs.length) {
      list.replaceChildren(h('li', { class: 'muted' }, searchInput.value ? 'No matching songs.' : 'Start typing to search.'));
      return;
    }
    const inPlaylist = new Set(playlist.songs.map((s) => s.id));
    list.replaceChildren(...songs.map((song) => h('li', {},
      h('div', { class: 'track' }, cover(song), h('div', {}, h('strong', {}, song.title), h('span', {}, song.artist))),
      inPlaylist.has(song.id)
        ? h('span', { class: 'genre-tag' }, 'Added')
        : h('button', {
          type: 'button', class: 'btn btn-mint btn-sm', 'aria-label': `Add ${song.title}`,
          onclick: () => mutate(`/api/playlists/${playlist.id}/songs`, { method: 'POST', body: { song_id: song.id } }, `Added "${song.title}".`),
        }, icon('plus'), 'Add'))));
  }

  function openRename() {
    renameForm.reset();
    clearErrors(renameForm);
    renameForm.elements.name.value = playlist.name;
    renameForm.elements.description.value = playlist.description || '';
    renameDialog.showModal();
  }

  renameForm.onsubmit = async (e) => {
    e.preventDefault();
    const values = validateForm(renameForm, schemas.playlist);
    if (!values) return;
    await withBusy(document.getElementById('rename-submit'), async () => {
      try {
        ({ playlist } = await api(`/api/playlists/${playlist.id}`, { method: 'PATCH', body: values }));
        renameDialog.close();
        document.title = `${playlist.name} · Myousik`;
        render();
        toast('Playlist updated.');
      } catch (err) {
        showApiError(renameForm, err);
      }
    });
  };

  function openDelete() {
    document.getElementById('delete-text').textContent = `"${playlist.name}" and its song order will be deleted. The songs stay in the library.`;
    deleteDialog.showModal();
  }
  document.getElementById('delete-confirm').onclick = async () => {
    try {
      await api(`/api/playlists/${playlist.id}`, { method: 'DELETE' });
      location.href = '/playlists';
    } catch (err) {
      deleteDialog.close();
      toast(err.message, { error: true });
    }
  };

  render();
  search();
}

function withDisabled(button, disabled) {
  button.disabled = disabled;
  return button;
}
