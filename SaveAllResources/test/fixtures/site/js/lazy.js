const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.src = e.target.dataset.src;
      io.unobserve(e.target);
    }
  }
});
document.querySelectorAll('img.js-lazy').forEach((img) => io.observe(img));
