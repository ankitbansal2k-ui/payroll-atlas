    // Motion: IntersectionObserver drives visibility (robust, no dependency on scroll-position
    // math at load time); GSAP performs the tween itself. A hard safety timeout guarantees
    // every [data-reveal]/[data-reveal-item] element is fully visible even if JS is slow,
    // GSAP fails to load, or the observer never fires — content must never stay hidden.
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const revealEls = document.querySelectorAll('[data-reveal], [data-reveal-item]');

    function showInstant(el) {
      el.style.opacity = 1;
      el.style.transform = 'none';
      el.style.filter = 'none';
    }

    if (reduceMotion || !window.gsap) {
      revealEls.forEach(showInstant);
    } else {
      revealEls.forEach(el => {
        gsap.set(el, { opacity: 0, y: 22, filter: 'blur(5px)' });
      });

      const groupChildren = new Set();
      document.querySelectorAll('[data-reveal-group]').forEach(group => {
        const items = [...group.querySelectorAll(':scope > [data-reveal-item]')];
        items.forEach(el => groupChildren.add(el));
        const groupObserver = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            gsap.to(items, {
              opacity: 1, y: 0, filter: 'blur(0px)',
              duration: 0.7, stagger: 0.12,
              ease: 'cubic-bezier(0.32,0.72,0,1)'
            });
            groupObserver.disconnect();
          });
        }, { threshold: 0.15, rootMargin: '0px 0px -10% 0px' });
        groupObserver.observe(group);
      });

      const singleObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          const delay = parseFloat(el.getAttribute('data-reveal-delay')) || 0;
          gsap.to(el, {
            opacity: 1, y: 0, filter: 'blur(0px)',
            duration: 0.9, delay,
            ease: 'cubic-bezier(0.32,0.72,0,1)'
          });
          singleObserver.unobserve(el);
        });
      }, { threshold: 0.1, rootMargin: '0px 0px -8% 0px' });

      document.querySelectorAll('[data-reveal]').forEach(el => {
        if (!groupChildren.has(el)) singleObserver.observe(el);
      });

      // Safety net: force full visibility after 2s no matter what went wrong above.
      setTimeout(() => revealEls.forEach(el => {
        if (getComputedStyle(el).opacity !== '1') showInstant(el);
      }), 2000);
    }

    // Tagline reveal: words light up one at a time as the section crosses the trigger line.
    const taglineEl = document.querySelector('[data-word-reveal]');
    if (taglineEl) {
      const words = taglineEl.textContent.trim().split(/\s+/);
      taglineEl.textContent = '';
      words.forEach((w, i) => {
        if (i) taglineEl.append(' ');
        const span = document.createElement('span');
        span.className = 'word';
        span.textContent = w;
        taglineEl.append(span);
      });
      const wordEls = taglineEl.querySelectorAll('.word');

      if (reduceMotion) {
        wordEls.forEach(w => w.classList.add('lit'));
      } else {
        const total = wordEls.length;
        const onScroll = () => {
          const rect = taglineEl.getBoundingClientRect();
          const vh = window.innerHeight;
          const start = vh * 0.75;
          const end = vh * 0.3;
          const progress = Math.min(1, Math.max(0, (start - rect.top) / (start - end)));
          const lit = Math.floor(progress * total);
          wordEls.forEach((w, i) => w.classList.toggle('lit', i <= lit));
        };
        let ticking = false;
        window.addEventListener('scroll', () => {
          if (!ticking) {
            requestAnimationFrame(() => { onScroll(); ticking = false; });
            ticking = true;
          }
        }, { passive: true });
        onScroll();
      }
    }
