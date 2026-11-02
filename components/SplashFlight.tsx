"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { FlightWorld } from "@/lib/three/flightWorld";

const MAP_URL = "/media/east-timor-map-mhn.jpg";

type Props = {
  progress: number;
  ready: boolean;
  onReveal: () => void;
  onDone: () => void;
};

export default function SplashFlight({ progress, ready, onReveal, onDone }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLParagraphElement>(null);
  const worldRef = useRef<FlightWorld | null>(null);
  const flightTl = useRef<gsap.core.Timeline | null>(null);
  const [landed, setLanded] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const leaving = useRef(false);
  const callbacks = useRef({ onReveal, onDone });
  callbacks.current = { onReveal, onDone };

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    // ?intro=0 goes straight to the site (handy for sharing a direct link).
    if (new URLSearchParams(window.location.search).get("intro") === "0") {
      callbacks.current.onReveal();
      callbacks.current.onDone();
      return;
    }
    // Fresh canvas per mount, since dispose() leaves the old context lost.
    const canvas = document.createElement("canvas");
    canvas.className = "splash-canvas";
    host.appendChild(canvas);
    const quality = window.innerWidth < 768 || window.matchMedia("(pointer: coarse)").matches ? "low" : "high";
    let world: FlightWorld;
    try {
      world = new FlightWorld(canvas, quality);
    } catch {
      // No WebGL: skip the flight once React has finished this commit.
      let cancelled = false;
      queueMicrotask(() => !cancelled && setLanded(true));
      return () => {
        cancelled = true;
        canvas.remove();
      };
    }
    worldRef.current = world;
    world.onRegion = (name) => {
      const el = regionRef.current;
      if (!el) return;
      gsap.fromTo(el, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.6, ease: "power2.out" });
      el.textContent = name;
    };
    let cancelled = false;
    world
      .load(MAP_URL)
      .then(() => {
        if (cancelled) return;
        world.start();
        setMapReady(true);
      })
      .catch(() => !cancelled && setLanded(true));
    const onResize = () => world.resize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      world.dispose();
      worldRef.current = null;
      canvas.remove();
    };
  }, []);

  // The intro is a story told against the clock: on a slow GPU it should drop
  // frames, not stretch to twice its length (GSAP's default lag smoothing).
  useEffect(() => {
    gsap.ticker.lagSmoothing(0);
    return () => gsap.ticker.lagSmoothing(500, 33);
  }, []);

  // The flight itself.
  useGSAP(
    () => {
      const world = worldRef.current;
      if (!mapReady || !world) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const s = world.state;
      const tl = gsap.timeline({ onComplete: () => setLanded(true) });
      flightTl.current = tl;
      if (reduced) {
        Object.assign(s, { flight: 0.86, chase: 1, arrive: 1 });
        tl.to([".splash-greeting", ".splash-greeting > *"], { autoAlpha: 1, duration: 0.6 }, 0.4);
        return;
      }
      tl.to(s, { flight: 0.97, duration: 9.4, ease: "power1.inOut" }, 0)
        .to(s, { chase: 1, duration: 3, ease: "power2.inOut" }, 1.2)
        .to(s, { arrive: 1, duration: 3.2, ease: "power2.inOut" }, 6.6)
        .fromTo(".splash-route", { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 1 }, 0.4)
        .to(".splash-route", { autoAlpha: 0, duration: 0.6 }, 7.6)
        .to(".splash-greeting", { autoAlpha: 1, duration: 1 }, 8)
        .fromTo(
          ".splash-greeting > *",
          { autoAlpha: 0, y: 30 },
          { autoAlpha: 1, y: 0, duration: 1.2, ease: "expo.out", stagger: 0.25 },
          8.2,
        );
    },
    { scope: rootRef, dependencies: [mapReady] },
  );

  // Leave once the plane has arrived and Cristo Rei is ready to be shown.
  useEffect(() => {
    if (!landed || !ready || leaving.current) return;
    leave(1.8);
  }, [landed, ready]);

  function leave(hold: number) {
    if (leaving.current) return;
    leaving.current = true;
    flightTl.current?.pause();
    const q = gsap.utils.selector(rootRef);
    const world = worldRef.current;
    const tl = gsap.timeline({ delay: hold });
    if (world) tl.to(world.state, { dive: 1, duration: 1.4, ease: "power2.in" }, 0);
    tl.to(q(".splash-veil"), { autoAlpha: 1, duration: 0.9, ease: "power1.in" }, 0.5)
      .add(() => {
        worldRef.current?.stop();
        gsap.set(q(".splash-canvas-host, .splash-hud, .splash-greeting"), { autoAlpha: 0 });
        callbacks.current.onReveal();
      })
      .to(q(".splash-veil"), { autoAlpha: 0, duration: 1.6, ease: "power2.out" }, "+=0.15")
      .add(() => callbacks.current.onDone());
  }

  const onSkip = () => {
    if (!ready) {
      // Fast-forward to the arrival and wait there for the statue.
      flightTl.current?.progress(1);
      return;
    }
    leave(0);
  };

  const pct = Math.round(progress * 100);

  return (
    <div ref={rootRef} className="splash" role="dialog" aria-label="Intro flight to Timor-Leste">
      <div ref={canvasHostRef} className="splash-canvas-host" aria-hidden="true" />
      <div className="splash-hud">
        <p className="splash-route" aria-live="polite">
          <span className="splash-route-label">Now flying over</span>
          <span ref={regionRef} className="splash-route-region">
            Savu Sea
          </span>
        </p>
        <div className="splash-status">
          <span className="splash-loading" aria-live="polite">
            {ready ? "Cristo Rei is ready" : pct > 0 ? `Loading Cristo Rei ${pct}%` : "Loading Cristo Rei"}
          </span>
          <button type="button" className="splash-skip" onClick={onSkip}>
            Skip intro
          </button>
        </div>
      </div>
      <div className="splash-greeting">
        <p className="splash-greeting-tetum">Bem-vindu ba Timor-Leste</p>
        <p className="splash-greeting-en">Welcome to Timor-Leste</p>
      </div>
      <div className="splash-veil" aria-hidden="true" />
    </div>
  );
}
