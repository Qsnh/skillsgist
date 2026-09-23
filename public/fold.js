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

function fold(doc) {
  if (doc.dataset.foldState) return;
  doc.dataset.foldState = "folded";
  if (doc.scrollHeight - doc.clientHeight < SLACK) {
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
  const frame = doc.parentElement;
  if (folding && frame.getBoundingClientRect().top < 0) frame.scrollIntoView();
});

docs.forEach(fold);
window.addEventListener("load", () => docs.forEach(fold));
