(() => {
  const nodes = document.querySelectorAll(".reveal");
  if (!nodes.length) {
    return;
  }
  const show = (el) => el.classList.add("is-in");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) {
    nodes.forEach(show);
    return;
  }
  // threshold 0: any visible pixel counts. Tall sections taller than the
  // viewport never meet a fractional threshold like 0.12.
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          show(e.target);
          io.unobserve(e.target);
        }
      });
    },
    { rootMargin: "0px 0px -40px 0px", threshold: 0 }
  );
  nodes.forEach((el) => io.observe(el));
})();
