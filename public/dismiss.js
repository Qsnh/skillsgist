const FLOATING = "details:is(.cf-menu, .cf-confirm)[open]";

function dismiss(details, refocus) {
  details.open = false;
  if (refocus) details.querySelector("summary").focus();
}

function dismissOutside(event) {
  for (const details of document.querySelectorAll(FLOATING)) {
    if (!details.contains(event.target)) dismiss(details, false);
  }
}

document.addEventListener("pointerdown", dismissOutside);
document.addEventListener("focusin", dismissOutside);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.isComposing) return;
  const active = document.activeElement;
  const adrift = !active || active === document.body;
  for (const details of document.querySelectorAll(FLOATING)) {
    dismiss(details, adrift || details.contains(active));
  }
});
