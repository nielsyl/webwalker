(() => {
  if (window.__webwalker) return;
  window.__webwalker = true;

  // ---------- overlay canvas ----------
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, {
    position: "fixed", inset: "0", width: "100vw", height: "100vh",
    pointerEvents: "none", zIndex: "2147483647"
  });
  document.documentElement.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener("resize", resize);
  resize();

  // Alt+S toggles the overlay
  let on = true;
  addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "s") {
      on = !on;
      canvas.style.display = on ? "block" : "none";
    }
  });

  // ---------- settings ----------
  const FILL = { user: "#ff3d8b", handle: "#5b5bff", views: "#22d3ee" };
  const OUTLINE = "#4a63ff";
  const S = 0.5;                  // overall spider size
  const SEG = 95 * S;             // length of each leg segment
  const REACH = SEG * 2;          // how far a leg can stretch
  const FOLLOW_DIST = 125;        // how far the spider stays from your cursor
  const WANDER_SPEED = 90;        // walking speed before you move the mouse
  const STEP_TIME = 0.1;          // seconds a leg takes to swing to a new spot
  const STEP_THRESH = 20;         // how far a foot may drift from its home spot before stepping
  const SNAP = 26;                // a foot lands on a box if one is this close to the landing spot
  const EDGE_ZONE = 150;          // top/bottom strip that scrolls the page
  const MAX_SCROLL = 400;         // top scroll speed (px per second)

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ease = (t) => t * t * (3 - 2 * t);

  // ---------- cursor ----------
  const mouse = { x: 0, y: 0, seen: false, inside: false, exit: 0, exitAt: 0 };
  addEventListener("mousemove", (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY;
    mouse.seen = true; mouse.inside = true; mouse.exit = 0;
  }, { passive: true });
  // cursor left the page: remember if it went out through the top or bottom
  document.addEventListener("mouseout", (e) => {
    if (e.relatedTarget) return;
    mouse.inside = false;
    const top = mouse.y < EDGE_ZONE, bottom = mouse.y > innerHeight - EDGE_ZONE;
    mouse.exit = top ? -1 : bottom ? 1 : 0;
    mouse.exitAt = performance.now();
    if (mouse.exit < 0) mouse.y = 0;
    if (mouse.exit > 0) mouse.y = innerHeight;
  });

  // ---------- find things to box ----------
  let targets = [];
  function refreshTargets() {
    const out = [];
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    if (tweets.length) {
      tweets.forEach((post) => {
        const nameBox = post.querySelector('[data-testid="User-Name"]');
        if (nameBox) {
          let gotUser = false, gotHandle = false;
          nameBox.querySelectorAll("a").forEach((a) => {
            const txt = (a.textContent || "").trim();
            if (!txt) return;
            if (txt.startsWith("@")) {
              if (!gotHandle) { out.push({ el: a, type: "handle" }); gotHandle = true; }
            } else if (!a.querySelector("time") && !gotUser) {
              out.push({ el: a, type: "user" }); gotUser = true;
            }
          });
        }
        const time = post.querySelector("time");
        if (time) out.push({ el: time.closest("a") || time, type: "handle" });
        const views = post.querySelector('a[href$="/analytics"]');
        if (views) out.push({ el: views, type: "views" });
      });
    } else {
      document.querySelectorAll("h1,h2,h3,a,button").forEach((el) => {
        const tag = el.tagName;
        out.push({ el, type: tag[0] === "H" ? "user" : tag === "A" ? "handle" : "views" });
      });
    }
    targets = out.slice(0, 120);
  }
  refreshTargets();
  setInterval(refreshTargets, 300);
  let lastRefresh = 0;
  addEventListener("scroll", () => {          // X swaps posts in and out while scrolling
    const n = performance.now();
    if (n - lastRefresh > 90) { lastRefresh = n; refreshTargets(); }
  }, { passive: true, capture: true });

  // ---------- scrolling ----------
  // scrolls the window; if the page uses an inner scroller, scrolls that instead
  function scrollPage(dy) {
    const before = scrollY;
    window.scrollBy({ top: dy, left: 0, behavior: "instant" });
    if (Math.abs(scrollY - before) > 0.01) return 0;   // the window moved (counted via scrollY)
    let el = document.elementFromPoint(clamp(mouse.x, 0, innerWidth - 1), clamp(mouse.y, 1, innerHeight - 2));
    while (el && el !== document.documentElement) {
      const st = getComputedStyle(el);
      if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1) {
        const b = el.scrollTop;
        el.scrollTop = b + dy;
        return el.scrollTop - b;
      }
      el = el.parentElement;
    }
    return 0;
  }

  // ---------- spider ----------
  const spider = { x: innerWidth / 2, y: innerHeight / 2, angle: Math.PI / 2, vx: 0, vy: 0, goal: null };

  // Home spots for the 4 leg pairs (forward, outward), rear to front, relative to the body.
  const HOME = [[-85, 105], [-30, 120], [35, 120], [95, 95]];
  const legs = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      legs.push({
        side,
        along: (-18 + i * 12) * S,                       // hip position along the body
        home: { f: HOME[i][0] * S, o: HOME[i][1] * S },
        // alternating gait: legs L1, L3, R2, R4 move together, then the other four
        group: (i + (side > 0 ? 1 : 0)) % 2,
        foot: null, step: null, last: null
      });
    }
  }

  function footPos(f) {
    if (f.el) {
      const r = f.el.getBoundingClientRect();
      return { x: r.left + f.u * r.width, y: r.top + f.v * r.height };
    }
    return { x: f.x, y: f.y };
  }

  // choose where a foot lands: on a nearby box if there is one, otherwise on the ground
  function pickFoot(land, hip, vis) {
    const d0 = dist(land, hip);
    if (d0 > REACH * 0.9) {
      const k = (REACH * 0.9) / d0;
      land = { x: hip.x + (land.x - hip.x) * k, y: hip.y + (land.y - hip.y) * k };
    }
    let best = null, bestD = SNAP;
    for (const e of vis) {
      const r = e.r;
      const p = { x: clamp(land.x, r.left + 2, r.right - 2), y: clamp(land.y, r.top + 2, r.bottom - 2) };
      const d = dist(p, land);
      if (d < bestD && dist(p, hip) <= REACH * 0.92) { bestD = d; best = { e, p }; }
    }
    if (best) {
      const r = best.e.r;
      return {
        el: best.e.t.el, type: best.e.t.type,
        u: (best.p.x - r.left) / Math.max(r.width, 1),
        v: (best.p.y - r.top) / Math.max(r.height, 1)
      };
    }
    return { x: land.x, y: land.y, type: null };
  }

  function kneeFor(hip, foot, body) {
    const dx = foot.x - hip.x, dy = foot.y - hip.y;
    const len = Math.hypot(dx, dy) || 1;
    const d = clamp(len, 8, SEG * 2 - 1);
    const ux = dx / len, uy = dy / len;
    const along = d / 2;
    const h = Math.sqrt(Math.max(SEG * SEG - along * along, 0));
    const mx = hip.x + ux * along, my = hip.y + uy * along;
    const k1 = { x: mx - uy * h, y: my + ux * h };
    const k2 = { x: mx + uy * h, y: my - ux * h };
    return dist(k1, body) > dist(k2, body) ? k1 : k2;   // knee bends away from the body
  }

  function clampFoot(hip, f) {
    const dx = f.x - hip.x, dy = f.y - hip.y;
    const d = Math.hypot(dx, dy) || 1;
    const maxD = SEG * 2 * 0.98;
    return d > maxD ? { x: hip.x + (dx / d) * maxD, y: hip.y + (dy / d) * maxD } : f;
  }

  function dot(p, color, r) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r || 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------- main loop ----------
  let last = performance.now();
  let lastSX = scrollX, lastSY = scrollY;
  const scrollVel = { x: 0, y: 0 };

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05) || 0.016;
    last = now;
    ctx.clearRect(0, 0, innerWidth, innerHeight);

    if (on) {
      // 1) scroll the page when the cursor is in the top/bottom strip (or just left through it)
      let push = 0;
      if (mouse.seen) {
        if (mouse.inside) {
          if (mouse.y > innerHeight - EDGE_ZONE) push = (mouse.y - (innerHeight - EDGE_ZONE)) / EDGE_ZONE;
          else if (mouse.y < EDGE_ZONE) push = -(EDGE_ZONE - mouse.y) / EDGE_ZONE;
        } else if (mouse.exit !== 0 && now - mouse.exitAt < 2500) {
          push = mouse.exit * 0.8;
        }
      }
      let innerDY = 0;
      if (push) {
        push = clamp(push, -1, 1);
        innerDY = scrollPage(Math.sign(push) * Math.pow(Math.abs(push), 1.5) * MAX_SCROLL * dt);
      }
      // how far the page moved since last frame (any cause)
      const dS = { x: scrollX - lastSX, y: scrollY - lastSY + innerDY };
      lastSX = scrollX; lastSY = scrollY;
      scrollVel.x += (dS.x / dt - scrollVel.x) * 0.3;
      scrollVel.y += (dS.y / dt - scrollVel.y) * 0.3;

      // 2) boxes on screen
      const vis = [];
      const visEls = new Set();
      for (const t of targets) {
        const r = t.el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        vis.push({ t, r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
        visEls.add(t.el);
      }

      // thin grey lines: each box to its 2 nearest neighbours
      ctx.strokeStyle = "rgba(160,160,160,0.35)";
      ctx.lineWidth = 1;
      const seen = new Set();
      vis.forEach((a, i) => {
        vis.map((b, j) => ({ j, d: i === j ? Infinity : Math.hypot(a.cx - b.cx, a.cy - b.cy) }))
          .sort((p, q) => p.d - q.d).slice(0, 2).forEach(({ j }) => {
            const key = i < j ? i + "-" + j : j + "-" + i;
            if (seen.has(key)) return;
            seen.add(key);
            ctx.beginPath();
            ctx.moveTo(a.cx, a.cy);
            ctx.lineTo(vis[j].cx, vis[j].cy);
            ctx.stroke();
          });
      });

      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.5;
      vis.forEach((e) => ctx.strokeRect(e.r.left, e.r.top, e.r.width, e.r.height));

      if (vis.length || mouse.seen) {
        // 3) body: follow the cursor, keep a gap (wander between boxes before the mouse moves)
        let mx, my, goalNow = null;
        if (mouse.seen) {
          mx = mouse.x; my = mouse.y;
          let bestD = Infinity;
          for (const e of vis) {
            const d = Math.hypot(e.cx - mx, e.cy - my);
            if (d < bestD) { bestD = d; goalNow = e; }
          }
        } else {
          if (!spider.goal || !visEls.has(spider.goal.t.el)) {
            spider.goal = vis[Math.floor(Math.random() * vis.length)];
          }
          goalNow = vis.find((e) => e.t.el === spider.goal.t.el) || vis[0];
          mx = goalNow.cx; my = goalNow.cy;
          if (Math.hypot(mx - spider.x, my - spider.y) < 30) {
            spider.goal = vis[Math.floor(Math.random() * vis.length)];
          }
        }
        const px = spider.x, py = spider.y;
        const gx = mx - spider.x, gy = my - spider.y;
        const gd = Math.hypot(gx, gy) || 1;
        const keep = mouse.seen ? FOLLOW_DIST : 0;
        const gap = gd - keep;
        if (gap > 4) {
          const speed = mouse.seen ? Math.min(1200, gap * 7) : WANDER_SPEED;
          const stepLen = Math.min(gap, speed * dt);
          spider.x += (gx / gd) * stepLen;
          spider.y += (gy / gd) * stepLen;
        } else if (mouse.seen && gd < keep * 0.7) {
          const back = Math.min(keep * 0.7 - gd, 350 * dt);
          spider.x -= (gx / gd) * back;
          spider.y -= (gy / gd) * back;
        }
        spider.x = clamp(spider.x, 12, innerWidth - 12);
        spider.y = clamp(spider.y, 12, innerHeight - 12);
        if (gd > 14) {
          let diff = Math.atan2(gy, gx) - spider.angle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          spider.angle += diff * Math.min(1, dt * 8);
        }
        spider.vx += ((spider.x - px) / dt - spider.vx) * 0.3;
        spider.vy += ((spider.y - py) / dt - spider.vy) * 0.3;

        const heading = { x: Math.cos(spider.angle), y: Math.sin(spider.angle) };
        const normal = { x: -heading.y, y: heading.x };
        const body = { x: spider.x, y: spider.y };

        if (goalNow) {
          ctx.strokeStyle = "#3b82f6";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(body.x, body.y);
          ctx.lineTo(goalNow.cx, goalNow.cy);
          ctx.stroke();
        }

        // 4) legs. Feet are glued to the page: to a box, or to the ground under it.
        // How fast the body slides over the page decides how far ahead feet land.
        const relX = spider.vx + scrollVel.x, relY = spider.vy + scrollVel.y;
        const relSpeed = Math.hypot(relX, relY);
        // the faster the body slides over the page, the quicker and longer the steps
        const stepDur = STEP_TIME * clamp(1 - relSpeed / 1500, 0.5, 1);
        const stepThresh = STEP_THRESH + Math.min(relSpeed * 0.03, 14);
        let lx = relX * 0.2, ly = relY * 0.2;
        const lm = Math.hypot(lx, ly), lmax = 34 + Math.min(relSpeed * 0.02, 10);
        if (lm > lmax) { lx *= lmax / lm; ly *= lmax / lm; }

        const drawLegs = [];
        const planted = [];
        for (const leg of legs) {
          const hip = {
            x: body.x + heading.x * leg.along + normal.x * leg.side * 7 * S,
            y: body.y + heading.y * leg.along + normal.y * leg.side * 7 * S
          };
          const home = {
            x: body.x + heading.x * leg.home.f + normal.x * leg.side * leg.home.o,
            y: body.y + heading.y * leg.home.f + normal.y * leg.home.o * leg.side
          };

          // ground feet ride along with the page when it scrolls
          if (leg.foot && !leg.foot.el) { leg.foot.x -= dS.x; leg.foot.y -= dS.y; }
          if (leg.step) {
            leg.step.from.x -= dS.x; leg.step.from.y -= dS.y;
            if (!leg.step.to.el) { leg.step.to.x -= dS.x; leg.step.to.y -= dS.y; }
          }
          // a box that scrolled out of the DOM: keep the foot where it last was
          if (leg.foot && leg.foot.el && !visEls.has(leg.foot.el) && leg.last) {
            leg.foot = { x: leg.last.x, y: leg.last.y, type: null };
          }
          if (leg.step && leg.step.to.el && !visEls.has(leg.step.to.el) && leg.step.lastTo) {
            leg.step.to = { x: leg.step.lastTo.x, y: leg.step.lastTo.y, type: null };
          }

          // advance a swing in progress
          if (leg.step) {
            leg.step.t += dt / leg.step.dur;
            if (leg.step.t >= 1) { leg.foot = leg.step.to; leg.step = null; }
          }
          let fp, swinging = false;
          if (leg.step) {
            const b = footPos(leg.step.to);
            leg.step.lastTo = b;
            const k = ease(leg.step.t);
            fp = {
              x: leg.step.from.x + (b.x - leg.step.from.x) * k,
              y: leg.step.from.y + (b.y - leg.step.from.y) * k
            };
            swinging = true;
          } else {
            if (!leg.foot) leg.foot = pickFoot(home, hip, vis);   // first frame: stand at home
            fp = footPos(leg.foot);
          }

          // time to step? only when the foot has drifted from its home spot,
          // and only if the other group of legs isn't mid-swing (alternating gait)
          if (!leg.step) {
            const drift = dist(fp, home);
            const stretch = dist(fp, hip);
            const emergency = stretch > REACH * 0.97;
            const otherBusy = legs.some((l) => l.step && l.group !== leg.group);
            if ((drift > stepThresh && !otherBusy) || emergency) {
              const land = { x: home.x + lx, y: home.y + ly };
              leg.step = {
                from: { x: fp.x, y: fp.y },
                to: pickFoot(land, hip, vis),
                t: 0,
                dur: emergency ? stepDur * 0.7 : stepDur
              };
              swinging = true;
            }
          }

          leg.last = { x: fp.x, y: fp.y };
          if (!leg.step && leg.foot && leg.foot.el && leg.foot.type) planted.push(leg.foot);
          drawLegs.push({ hip, fp, swinging });
        }

        // colour in the boxes that have a foot on them
        const filled = new Set();
        for (const f of planted) {
          if (filled.has(f.el)) continue;
          filled.add(f.el);
          const e = vis.find((v) => v.t.el === f.el);
          if (!e) continue;
          ctx.globalAlpha = 0.55;
          ctx.fillStyle = FILL[f.type];
          ctx.fillRect(e.r.left, e.r.top, e.r.width, e.r.height);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = FILL[f.type];
          ctx.lineWidth = 2;
          ctx.strokeRect(e.r.left, e.r.top, e.r.width, e.r.height);
        }

        // draw legs
        ctx.strokeStyle = "#4f46e5";
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const { hip, fp: rawFp, swinging } of drawLegs) {
          const fp = clampFoot(hip, rawFp);
          const knee = kneeFor(hip, fp, body);
          ctx.beginPath();
          ctx.moveTo(hip.x, hip.y);
          ctx.lineTo(knee.x, knee.y);
          ctx.lineTo(fp.x, fp.y);
          ctx.stroke();
          dot(knee, "#38bdf8", 2.2);
          dot(fp, swinging ? "#ffffff" : "#38bdf8", swinging ? 3.2 : 2.6);
        }

        // body: red rectangle with a small head at the front
        ctx.save();
        ctx.translate(body.x, body.y);
        ctx.rotate(spider.angle);
        ctx.fillStyle = "rgba(255,51,85,0.18)";
        ctx.fillRect(-24 * S, -9 * S, 48 * S, 18 * S);
        ctx.strokeStyle = "#ff3355";
        ctx.lineWidth = 2;
        ctx.strokeRect(-24 * S, -9 * S, 48 * S, 18 * S);
        ctx.fillStyle = "#ff3355";
        ctx.beginPath();
        ctx.arc(24 * S + 3, 0, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        dot(body, "#38bdf8", 2.5);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
