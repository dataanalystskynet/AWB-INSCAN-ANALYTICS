/* =====================================================================
   fx3d.js — 3D entrance for the dashboard cards: each card swings up
   into place (perspective + rotateX) the first time it scrolls into view.
   Hover lifts a card off the page. Skipped when the user prefers less motion.
   ===================================================================== */
(function (global) {
  'use strict';
  if (!('IntersectionObserver' in global) || (global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  function start() {
    const cards = Array.from(document.querySelectorAll('main .card, .card'));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const el = e.target;
        el.classList.add('fx-in');
        io.unobserve(el);
        // drop the helper classes after the swing so charts measure a flat card
        setTimeout(() => el.classList.remove('fx-pre', 'fx-in'), 1000);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });
    cards.forEach((el, i) => {
      if (el.dataset.fx) return;
      el.dataset.fx = '1';
      el.style.setProperty('--fx-delay', `${(i % 3) * 90}ms`);
      el.classList.add('fx-pre');
      io.observe(el);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(window);
