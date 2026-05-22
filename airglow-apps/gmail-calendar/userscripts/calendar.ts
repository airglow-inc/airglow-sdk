// Gmail Calendar — calendar frame helper
// Runs on calendar.google.com; strips UI chrome when loaded inside an iframe

let inIframe = false;
try { inIframe = window !== window.top; } catch { inIframe = true; }

airglow.log.info(`calendar frame loaded, inIframe=${inIframe}`);

if (inIframe) {
  const style = document.createElement('style');
  style.textContent = `
    /* Hide top Google bar, header toolbar, left sidebar, right mini sidebar */
    #gb, [role="banner"] { display: none !important; }
    [role="complementary"] { display: none !important; }
    [role="navigation"] { display: none !important; }
    [role="heading"] { display: none !important; }
    header { display: none !important; }

    /* Hide everything except the month grid */
    [data-view-heading] { display: none !important; }

    /* Make the grid and all its ancestors fill the viewport */
    [role="main"], [role="main"] * {
      margin: 0 !important; padding: 0 !important;
    }
    [role="grid"] {
      position: fixed !important;
      top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important;
    }

    /* Hide the right-side icon strip (Tasks, Keep, Contacts, etc.) */
    aside, [data-ogsr-up] { display: none !important; }
  `;
  document.documentElement.appendChild(style);

  const hideExtras = () => {
    const main = document.querySelector('[role="main"]');
    if (!main) return;
    // Hide all top-level siblings that don't contain the main grid
    for (const child of document.body.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.contains(main)) continue;
      child.style.display = 'none';
    }
    // Walk from the main grid up to body, hiding all siblings at each level
    const grid = main.querySelector('[role="grid"]');
    if (grid) {
      let el: HTMLElement | null = grid as HTMLElement;
      while (el && el !== document.body) {
        for (const sib of el.parentElement!.children) {
          if (sib === el || !(sib instanceof HTMLElement)) continue;
          sib.style.display = 'none';
        }
        el = el.parentElement as HTMLElement | null;
      }
    }
  };

  const runHide = () => {
    hideExtras();
    // Re-run after calendar finishes rendering (it loads async)
    setTimeout(hideExtras, 1000);
    setTimeout(hideExtras, 3000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runHide);
  } else {
    runHide();
  }
}
