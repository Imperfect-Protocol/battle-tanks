let closePromptSuppression: (() => void) | null = null;

export function closeCurrentTab() {
  allowTabCloseWithoutPrompt();
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) {
    activeElement.blur();
  }

  window.onbeforeunload = null;
  window.close();
}

export function allowTabCloseWithoutPrompt() {
  if (closePromptSuppression) {
    return closePromptSuppression;
  }

  const suppressBeforeUnload = (event: BeforeUnloadEvent) => {
    event.stopImmediatePropagation();
    delete event.returnValue;
  };

  window.addEventListener("beforeunload", suppressBeforeUnload, { capture: true });
  closePromptSuppression = () => {
    window.removeEventListener("beforeunload", suppressBeforeUnload, { capture: true });
    closePromptSuppression = null;
  };

  return closePromptSuppression;
}
