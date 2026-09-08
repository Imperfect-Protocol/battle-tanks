export function closeCurrentTab() {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) {
    activeElement.blur();
  }

  window.onbeforeunload = null;
  window.close();
}
