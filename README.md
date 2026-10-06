# Webwalker

A Chrome extension that draws a small stick-figure spider over a web page. The spider follows your cursor and plants its legs on boxed elements. On X.com it boxes usernames, handles, dates and view counts. On other sites it boxes headings, links and buttons.

Built with plain JavaScript and a `<canvas>` overlay. No libraries.

## Install (Chrome, Edge, Brave)

1. Download this repository (green **Code** button, then **Download ZIP**) and unzip it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
5. Open a page and refresh it.

Press **Alt+S** to turn the overlay on and off.

## How it works

- A transparent full-screen canvas sits on top of the page and ignores clicks.
- Page elements are found with DOM selectors a few times per second.
- Every frame, each element's position is read with `getBoundingClientRect`, so the boxes stay attached while you scroll.
- The spider body follows the cursor and keeps a small distance from it.
- Each of the 8 legs plants its foot inside a box, then steps to a new box when it gets stretched too far. Knees are placed with simple two-bone geometry.
- Moving the cursor to the top or bottom edge of the window scrolls the page.

## Notes

- It runs only in your browser. It doesn't send data anywhere and doesn't click, post or interact with the page.
- X changes its page markup often, so the selectors may need updating.
