const RESET_MS = 2000;
const LABELS = document.body.dataset;
const TEXT = {
  copied: LABELS.copyDone,
  manual: /Mac|iPhone|iPad/.test(navigator.userAgent) ? LABELS.copyMac : LABELS.copyOther,
};
const timers = new WeakMap();

function selectContents(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copyFrom(node) {
  const text = node.textContent.trim();
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  selectContents(node);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

function show(block, state) {
  clearTimeout(timers.get(block));
  const label = block.querySelector(".cf-command-copy-label");
  const status = block.querySelector(".cf-command-status");
  if (state) {
    block.dataset.copyState = state;
    label.textContent = TEXT[state];
    status.textContent = TEXT[state];
    timers.set(block, setTimeout(() => show(block, null), RESET_MS));
  } else {
    delete block.dataset.copyState;
    label.textContent = LABELS.copyIdle;
    status.textContent = "";
  }
}

document.addEventListener("click", async (event) => {
  const block = event.target.closest(".cf-command[data-copy]");
  if (!block) return;
  const copied = await copyFrom(block.querySelector(".cf-command-text"));
  show(block, copied ? "copied" : "manual");
});

for (const block of document.querySelectorAll(".cf-command[data-copy]")) {
  block.dataset.copy = "ready";
  block.querySelector(".cf-command-copy").hidden = false;
}
