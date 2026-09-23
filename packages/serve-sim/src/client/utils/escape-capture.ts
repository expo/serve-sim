export function onEscapeCapture(target: EventTarget, handle: () => void): () => void {
  const listener = (event: Event): void => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    handle();
  };
  target.addEventListener("keydown", listener, true);
  return () => target.removeEventListener("keydown", listener, true);
}
