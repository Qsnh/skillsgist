const SLACK = 200;
const docs = document.querySelectorAll("[data-fold]");

function toggleFor(doc) {
  return document.querySelector(`[aria-controls="${doc.id}"]`);
}

function setFolded(doc, folded) {
  const toggle = toggleFor(doc);
  doc.dataset.foldState = folded ? "folded" : "open";
  toggle.setAttribute("aria-expanded", String(!folded));
  toggle.textContent = folded ? "Show more" : "Show less";
}

function obscured(doc, node) {
  const fade = parseFloat(getComputedStyle(doc).getPropertyValue("--cf-fold-fade"));
  return node.getBoundingClientRect().bottom > doc.getBoundingClientRect().bottom - fade;
}

function fold(doc) {
  if (doc.dataset.foldState) return;
  doc.dataset.foldState = "folded";
  const current = doc.querySelector("[aria-current]");
  if (doc.scrollHeight - doc.clientHeight < SLACK || (current && obscured(doc, current))) {
    delete doc.dataset.foldState;
    return;
  }
  setFolded(doc, true);
  toggleFor(doc).parentElement.hidden = false;
}

document.addEventListener("click", (event) => {
  const toggle = event.target.closest("[aria-controls]");
  const doc = toggle && document.getElementById(toggle.getAttribute("aria-controls"));
  if (!doc || !doc.dataset.foldState) return;
  const folding = doc.dataset.foldState === "open";
  setFolded(doc, folding);
  const frame = doc.closest(".cf-frame");
  if (folding && frame.getBoundingClientRect().top < 0) frame.scrollIntoView();
});

document.addEventListener("focusin", (event) => {
  const doc = event.target.closest('[data-fold-state="folded"]');
  if (doc && obscured(doc, event.target)) setFolded(doc, false);
});

docs.forEach(fold);
window.addEventListener("load", () => docs.forEach(fold));
