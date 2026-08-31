/**
 * Focus the first control a submitted step rejected.
 *
 * The rule this exists to keep (spec section 9) is a timing rule, not a
 * styling one: a wizard may mark a field invalid whenever it likes, but the
 * cursor may only be moved once the person has *submitted* a step. Focusing
 * while they are still typing takes the caret out from under them.
 *
 * The invalid set is read from the DOM rather than from a wizard's state,
 * because `aria-invalid` is what the assistive technology reads too — so the
 * field that is announced as broken is exactly the field that gets focus.
 */

const FOCUSABLE = [
  "input",
  "select",
  "textarea",
  "button",
  "[tabindex]",
  '[contenteditable="true"]',
].join(",");

function isFocusable(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hasAttribute("disabled")) return false;
  if (element.getAttribute("tabindex") === "-1") return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  return element.matches(FOCUSABLE);
}

/**
 * Returns the element that took focus, or `null` when the step has nothing
 * invalid in it — which is the ordinary case of a step that passed.
 */
export function focusFirstInvalidField(container: HTMLElement | null): HTMLElement | null {
  if (container === null) return null;

  for (const candidate of container.querySelectorAll('[aria-invalid="true"]')) {
    if (isFocusable(candidate)) {
      candidate.focus();
      return candidate;
    }
  }

  return null;
}
