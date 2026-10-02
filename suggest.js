// Suggestion form: records when the form was opened (a simple bot check on the server)
// and shows the "country not listed" box only when it is needed.
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form.suggest');
  if (!form) return;
  form.elements.t.value = String(Date.now());
  const country = form.elements.country;
  const other = form.elements.otherCountry;
  const otherLabel = form.querySelector('label[for="s-other"]');
  const sync = () => { const show = country.value === 'other'; other.hidden = !show; otherLabel.hidden = !show; };
  country.addEventListener('change', sync);
  sync();
});
