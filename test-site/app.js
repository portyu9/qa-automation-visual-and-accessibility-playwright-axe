const renderedAt = document.querySelector('[data-visual-dynamic]');
if (renderedAt) {
  renderedAt.textContent = new Date().toISOString();
}

const dialog = document.querySelector('[data-confirm-dialog]');
const openDialogButton = document.querySelector('[data-open-dialog]');
const closeDialogButton = document.querySelector('[data-close-dialog]');
const confirmButton = document.querySelector('[data-confirm]');

if (dialog instanceof HTMLDialogElement && openDialogButton instanceof HTMLButtonElement) {
  openDialogButton.addEventListener('click', () => dialog.showModal());
  closeDialogButton?.addEventListener('click', () => dialog.close('cancel'));
  confirmButton?.addEventListener('click', () => dialog.close('confirm'));
}

for (const tabRoot of document.querySelectorAll('[data-tabs]')) {
  const tabs = [...tabRoot.querySelectorAll('[role="tab"]')];

  const activate = (tab) => {
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      const panelId = candidate.getAttribute('aria-controls');
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel) {
        panel.hidden = !selected;
      }
    }
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();

      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;

      const next = tabs[nextIndex];
      if (next instanceof HTMLButtonElement) {
        activate(next);
        next.focus();
      }
    });
  });
}

const requestForm = document.querySelector('[data-request-form]');
const formStatus = document.querySelector('[data-form-status]');
if (requestForm instanceof HTMLFormElement && formStatus instanceof HTMLElement) {
  requestForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = requestForm.elements.namedItem('title');
    const risk = requestForm.elements.namedItem('risk');

    if (!(title instanceof HTMLInputElement) || !(risk instanceof HTMLSelectElement)) return;

    title.removeAttribute('aria-invalid');
    risk.removeAttribute('aria-invalid');

    if (title.value.trim().length < 3) {
      title.setAttribute('aria-invalid', 'true');
      formStatus.textContent = 'Request title must contain at least three characters.';
      title.focus();
      return;
    }

    if (risk.value === '') {
      risk.setAttribute('aria-invalid', 'true');
      formStatus.textContent = 'Choose a risk level before validation can complete.';
      risk.focus();
      return;
    }

    formStatus.textContent = 'Request is ready for review.';
  });
}
