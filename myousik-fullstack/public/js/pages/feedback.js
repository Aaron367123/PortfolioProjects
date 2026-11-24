/**
 * Feedback form: validated in the browser with the shared rules, then
 * validated again (authoritatively) by POST /api/feedback. If the server
 * rejects anything, its field messages are shown next to the same fields.
 *
 * v1 bugs fixed here: the script looked for input#feed but the field was a
 * <textarea>, so feedback was never checked; the rating was never checked;
 * and a "success" page was shown without anything being sent anywhere.
 */
import { api } from '../api.js';
import { icon } from '../dom.js';
import { initLayout } from '../layout.js';
import { validateForm, showApiError, withBusy } from '../forms.js';
import { schemas } from '../shared/validation.js';

await initLayout();

const form = document.getElementById('feedback-form');
const success = document.getElementById('feedback-success');
const comments = form.elements.comments;
const counter = document.getElementById('comments-count');
document.getElementById('tick').append(icon('check'));

comments.addEventListener('input', () => {
  counter.textContent = `${comments.value.length} / 2000`;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = validateForm(form, schemas.feedback);
  if (!values) return;
  await withBusy(form.querySelector('[type=submit]'), async () => {
    try {
      const { feedback } = await api('/api/feedback', { method: 'POST', body: values });
      document.getElementById('success-text').textContent = `We've saved your message, ${feedback.name}. Feedback #${feedback.id} is in.`;
      form.hidden = true;
      success.hidden = false;
      success.focus();
    } catch (err) {
      showApiError(form, err);
    }
  });
});

document.getElementById('send-another').addEventListener('click', () => {
  form.reset();
  counter.textContent = '0 / 2000';
  success.hidden = true;
  form.hidden = false;
  form.elements.name.focus();
});
