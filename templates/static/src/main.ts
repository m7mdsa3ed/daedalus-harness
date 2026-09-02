import "./style.css";

// Shared by every page — keep page-specific code behind a check for the
// element it needs, so a page without it does not throw.
const counter = document.querySelector<HTMLButtonElement>("#counter");
if (counter) {
  let count = 0;
  counter.addEventListener("click", () => {
    count += 1;
    counter.textContent = `Clicked ${count} ${count === 1 ? "time" : "times"}`;
  });
}
