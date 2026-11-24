/**
 * The bottom player bar. One <audio> element for the whole page; any
 * component can call playSong(song) or togglePlayback(). State changes are
 * broadcast as a "player:change" event so buttons elsewhere can update.
 *
 * (v1's player script ran in <head> before the DOM existed, so
 * getElementById returned null. ES modules are deferred, which avoids that.)
 */
import { h, icon, cover, formatDuration } from './dom.js';

let audio;
let bar;
let current = null;
const els = {};

export function initPlayer() {
  if (bar) return;
  audio = new Audio();
  audio.preload = 'none';

  els.cover = h('div');
  els.title = h('strong', {}, '');
  els.artist = h('span', {}, '');
  els.toggle = h('button', { type: 'button', class: 'play-btn', 'aria-label': 'Play', onclick: togglePlayback }, icon('play'));
  els.time = h('span', {}, '0:00');
  els.duration = h('span', {}, '0:00');
  els.seek = h('input', { type: 'range', min: '0', max: '100', step: '0.1', value: '0', 'aria-label': 'Seek' });
  els.seek.addEventListener('input', () => {
    if (audio.duration) audio.currentTime = (els.seek.value / 100) * audio.duration;
  });

  bar = h('section', { class: 'player', 'aria-label': 'Audio player', hidden: true },
    h('div', { class: 'container player-inner' },
      h('div', { class: 'track' }, els.cover, h('div', {}, els.title, els.artist)),
      els.toggle,
      h('div', { class: 'progress' }, els.time, els.seek, els.duration),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close player', onclick: closePlayer }, icon('close'))));
  document.body.append(bar);

  audio.addEventListener('play', sync);
  audio.addEventListener('pause', sync);
  audio.addEventListener('ended', sync);
  audio.addEventListener('timeupdate', () => {
    els.time.textContent = formatDuration(audio.currentTime);
    if (audio.duration) els.seek.value = String((audio.currentTime / audio.duration) * 100);
  });
  audio.addEventListener('loadedmetadata', () => { els.duration.textContent = formatDuration(audio.duration); });
  audio.addEventListener('error', () => {
    els.artist.textContent = 'Could not load this audio file.';
  });
}

function sync() {
  const playing = !audio.paused;
  els.toggle.replaceChildren(icon(playing ? 'pause' : 'play'));
  els.toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  document.dispatchEvent(new CustomEvent('player:change', { detail: { song: current, playing } }));
}

/** Start playing a song (must have audio_url). */
export function playSong(song) {
  initPlayer();
  if (!song.audio_url) return false;
  if (current?.id === song.id) {
    togglePlayback();
    return true;
  }
  current = song;
  audio.src = song.audio_url;
  els.cover.replaceChildren(cover(song));
  els.title.textContent = song.title;
  els.artist.textContent = song.artist;
  els.duration.textContent = '0:00';
  bar.hidden = false;
  document.documentElement.style.setProperty('--player-h', `${bar.offsetHeight}px`);
  audio.play().catch(() => sync());
  return true;
}

export function togglePlayback() {
  if (!current) return;
  if (audio.paused) audio.play().catch(() => sync());
  else audio.pause();
}

export const nowPlaying = () => ({ song: current, playing: audio ? !audio.paused : false });

function closePlayer() {
  audio.pause();
  audio.removeAttribute('src');
  current = null;
  bar.hidden = true;
  document.documentElement.style.setProperty('--player-h', '0px');
  sync();
}
