"use client";

/**
 * Skip-to-content link for keyboard and screen reader users.
 *
 * Rendered as the first focusable element in the page.
 * Visually hidden until focused; clicking or pressing Enter/Space scrolls
 * to #main-content and sets focus there.
 *
 * Usage: render as the first child of <body> before the site header.
 */

export function SkipToContent() {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const target = document.getElementById("main-content");
    if (target !== null) {
      target.focus({ preventScroll: false });
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <a
      href="#main-content"
      onClick={handleClick}
      className={[
        // Visually hidden until focused
        "absolute left-4 top-4 z-[9999]",
        "rounded-md px-4 py-2",
        "bg-brand-600 text-white text-sm font-semibold shadow-lg",
        // Transition from off-screen to visible on focus
        "-translate-y-20 focus:translate-y-0",
        "transition-transform duration-150",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-600",
      ].join(" ")}
    >
      Skip to main content
    </a>
  );
}
