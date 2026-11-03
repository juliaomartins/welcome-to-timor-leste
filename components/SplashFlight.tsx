"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { FlightWorld } from "@/lib/three/flightWorld";
import { DiliWorld } from "@/lib/three/diliWorld";
import { bakeDiliGround } from "@/lib/three/diliCity";
import { createIntroRenderer, detectTier } from "@/lib/three/deviceTier";

/** If Dili is still building this long after the island act ends, skip to the site. */
const DILI_PATIENCE_MS = 10000;

const RELIEF_URL = "/data/timor-relief.png";

type Props = {
  progress: number;
  ready: boolean;
  /** The screen is covered by the cloud veil: a good moment for heavy main-thread work. */
  onCurtain: () => void;
  /** The veil is opaque: swap in the site. The veil lifts once this settles. */
  onReveal: () => void | Promise<void>;
  onDone: () => void;
};

type Stage = "island" | "dili";

// Two acts: the island seen from cruising altitude, then — after a dive through
// the clouds — Dili at true scale, from the Tasi Tolu lakes over the Government
// Palace to Cristo Rei. Dili is built in the background during the first act.
export default function SplashFlight({ progress, ready, onCurtain, onReveal, onDone }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLParagraphElement>(null);
  const islandRef = useRef<FlightWorld | null>(null);
  const diliRef = useRef<DiliWorld | null>(null);
  const timeline = useRef<gsap.core.Timeline | null>(null);
  const [stage, setStage] = useState<Stage>("island");
  const [islandReady, setIslandReady] = useState(false);
  const [islandDone, setIslandDone] = useState(false);
  const [diliState, setDiliState] = useState<"loading" | "ready" | "failed">("loading");
  const [cityProgress, setCityProgress] = useState(0);
  const diliStateRef = useRef(diliState);
  useEffect(() => {
    diliStateRef.current = diliState;
  }, [diliState]);
  const [landed, setLanded] = useState(false);
  const leaving = useRef(false);
  const switching = useRef(false);
  const callbacks = useRef({ onCurtain, onReveal, onDone });
  callbacks.current = { onCurtain, onReveal, onDone };

  const showRegion = (name: string) => {
    const el = regionRef.current;
    if (!el) return;
    gsap.fromTo(el, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.6, ease: "power2.out" });
    el.textContent = name;
  };

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    // ?intro=0 goes straight to the site (handy for sharing a direct link).
    if (new URLSearchParams(window.location.search).get("intro") === "0") {
      callbacks.current.onCurtain();
      callbacks.current.onReveal();
      callbacks.current.onDone();
      return;
    }
    const settings = detectTier();
    // Development aid: ?bake=ground exposes window.__bake() to regenerate public/data/dili-ground.jpg.
    if (process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).get("bake") === "ground")
      (window as unknown as { __bake: unknown }).__bake = () => bakeDiliGround(settings);
    let cancelled = false;
    // One canvas and one WebGL context for both acts; a fresh canvas per mount,
    // since disposing a renderer leaves its context lost.
    const canvas = document.createElement("canvas");
    canvas.className = "splash-canvas";
    host.appendChild(canvas);

    let renderer: ReturnType<typeof createIntroRenderer> | null = null;
    let island: FlightWorld | null = null;
    let dili: DiliWorld | null = null;
    try {
      renderer = createIntroRenderer(canvas, settings);
      island = new FlightWorld(renderer, settings);
      dili = new DiliWorld(renderer, settings);
    } catch {
      // No WebGL: skip both acts once React has finished this commit.
      island?.dispose();
      renderer?.dispose();
      queueMicrotask(() => {
        if (cancelled) return;
        callbacks.current.onCurtain();
        setIslandDone(true);
        setDiliState("failed");
        setLanded(true);
      });
      return () => {
        cancelled = true;
        canvas.remove();
      };
    }
    islandRef.current = island;
    diliRef.current = dili;
    island.onRegion = showRegion;
    dili.onRegion = showRegion;
    // Development aid: ?intro=dili jumps straight to the second act.
    const diliOnly = process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).get("intro") === "dili";
    if (process.env.NODE_ENV !== "production") (window as unknown as { __intro: object }).__intro = { island, dili, renderer, settings };
    // The city worker starts shortly after the island flight is under way, so the
    // first seconds of the flight get the CPU to themselves on modest devices.
    let diliStarted = false;
    const startDili = () => {
      if (diliStarted || cancelled) return;
      diliStarted = true;
      dili
        ?.load((p) => !cancelled && setCityProgress(p))
        .then(() => !cancelled && setDiliState("ready")) // built in the worker; assembled behind the veil
        .catch((err) => {
          if (cancelled) return;
          console.error("Dili could not be built", err);
          setDiliState("failed");
        });
    };
    const diliTimer = window.setTimeout(startDili, 4000); // whatever happens with the island
    island
      .load(RELIEF_URL)
      .then(() => {
        if (cancelled) return;
        if (diliOnly) {
          startDili();
          setIslandDone(true);
          return;
        }
        island?.start();
        setIslandReady(true);
        window.setTimeout(startDili, 1200);
      })
      .catch(() => {
        if (cancelled) return;
        startDili();
        setIslandDone(true);
      });
    const onResize = () => {
      islandRef.current?.resize();
      diliRef.current?.resize();
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      window.clearTimeout(diliTimer);
      window.removeEventListener("resize", onResize);
      islandRef.current?.dispose();
      diliRef.current?.dispose();
      islandRef.current = null;
      diliRef.current = null;
      renderer?.dispose();
      renderer?.forceContextLoss();
      canvas.remove();
    };
  }, []);

  // A slow device must not hold visitors in the clouds: give the city a few
  // seconds after the island act, then carry on to the site without it.
  useEffect(() => {
    if (!islandDone || diliState !== "loading") return;
    const t = window.setTimeout(() => {
      diliRef.current?.dispose();
      diliRef.current = null;
      setDiliState("failed");
    }, DILI_PATIENCE_MS);
    return () => window.clearTimeout(t);
  }, [islandDone, diliState]);

  // The intro is a story told against the clock: on a slow GPU it should drop
  // frames, not stretch to twice its length (GSAP's default lag smoothing).
  useEffect(() => {
    gsap.ticker.lagSmoothing(0);
    return () => gsap.ticker.lagSmoothing(500, 33);
  }, []);

  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Act one: the island.
  useGSAP(
    () => {
      const world = islandRef.current;
      if (!islandReady || !world) return;
      const s = world.state;
      // If the city is still building on the final approach, fly slower rather than stall.
      const tl = gsap.timeline({
        onComplete: () => setIslandDone(true),
        onUpdate: () => {
          const waiting = tl.time() > 5.5 && diliStateRef.current === "loading";
          tl.timeScale(waiting ? 0.45 : 1);
        },
      });
      timeline.current = tl;
      if (reduced()) {
        Object.assign(s, { flight: 0.86, chase: 1, arrive: 1 });
        tl.to({}, { duration: 1 });
        return;
      }
      tl.to(s, { flight: 0.9, duration: 7.6, ease: "power1.inOut" }, 0)
        .to(s, { chase: 1, duration: 2.6, ease: "power2.inOut" }, 1)
        .to(s, { arrive: 1, duration: 2.6, ease: "power2.inOut" }, 5)
        // A partial dive: deep enough to sell the descent, high enough to stay sharp while Dili finishes building.
        .to(s, { dive: 0.5, duration: 1.4, ease: "power2.in" }, 7.2)
        .fromTo(".splash-route", { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 1 }, 0.4);
    },
    { scope: rootRef, dependencies: [islandReady] },
  );

  // Between the acts: through the cloud veil, from the island to the city.
  useEffect(() => {
    if (stage !== "island" || !islandDone || switching.current || leaving.current) return;
    if (diliState !== "ready") return; // keep diving until the city is built (a failure ends the intro)
    switching.current = true;
    const q = gsap.utils.selector(rootRef);
    gsap.set(q(".splash-veil-caption"), { autoAlpha: 1 });
    gsap.to(q(".splash-veil"), {
      autoAlpha: 1,
      duration: 0.55,
      ease: "power1.in",
      onComplete: async () => {
        // Behind the veil: the landing scene and Dili are assembled here, where a
        // one-second pause is invisible, instead of hitching the flight.
        islandRef.current?.stop();
        callbacks.current.onCurtain();
        await new Promise((r) => requestAnimationFrame(r));
        await diliRef.current?.assemble();
        // Same canvas, same context: retire one act, start the other.
        islandRef.current?.dispose();
        islandRef.current = null;
        diliRef.current?.start();
        setStage("dili");
        gsap.to(q(".splash-veil"), {
          autoAlpha: 0,
          duration: 1.1,
          ease: "power2.out",
          delay: 0.1,
          onComplete: () => gsap.set(q(".splash-veil-caption"), { autoAlpha: 0 }),
        });
      },
    });
  }, [stage, islandDone, diliState]);

  // Act two: Dili, ending on Cristo Rei.
  useGSAP(
    () => {
      const world = diliRef.current;
      if (stage !== "dili" || !world) return;
      const s = world.state;
      const tl = gsap.timeline({ onComplete: () => setLanded(true) });
      timeline.current = tl;
      const greet = (at: number) =>
        tl
          .to(".splash-route", { autoAlpha: 0, duration: 0.6 }, at - 0.4)
          .to(".splash-greeting", { autoAlpha: 1, duration: 1 }, at)
          .fromTo(".splash-greeting > *", { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 1.2, ease: "expo.out", stagger: 0.25 }, at + 0.2);
      if (reduced()) {
        Object.assign(s, { flight: 0.9, orbit: 1 });
        greet(0.3);
        return;
      }
      tl.to(s, { flight: 1, duration: 12.5, ease: "sine.inOut" }, 0).to(s, { orbit: 1, duration: 3.2, ease: "power2.inOut" }, 10.4);
      greet(12.2);
      tl.to({}, { duration: 0.6 });
    },
    { scope: rootRef, dependencies: [stage] },
  );

  // Leave once the flight has ended (or the city could not be built) and the landing statue is ready.
  const finished = landed || (islandDone && diliState === "failed");
  useEffect(() => {
    // Without a Dili act there was no curtain between acts: build the landing scene now.
    if (finished) callbacks.current.onCurtain();
  }, [finished]);
  useEffect(() => {
    if (!finished || !ready || leaving.current) return;
    leave(1.6);
  }, [finished, ready]);

  function leave(hold: number) {
    if (leaving.current) return;
    leaving.current = true;
    timeline.current?.pause();
    const q = gsap.utils.selector(rootRef);
    gsap.to(q(".splash-veil"), {
      autoAlpha: 1,
      duration: 0.9,
      delay: hold,
      ease: "power1.in",
      onComplete: async () => {
        islandRef.current?.stop();
        diliRef.current?.stop();
        gsap.set(q(".splash-canvas-host, .splash-hud, .splash-greeting"), { autoAlpha: 0 });
        // Release the shared city from the intro so the home page can adopt it.
        diliRef.current?.dispose();
        diliRef.current = null;
        await callbacks.current.onReveal();
        gsap.to(q(".splash-veil"), {
          autoAlpha: 0,
          duration: 1.6,
          delay: 0.15,
          ease: "power2.out",
          onComplete: () => callbacks.current.onDone(),
        });
      },
    });
  }

  const onSkip = () => {
    if (!ready) {
      // Fast-forward this act and wait for the statue.
      timeline.current?.progress(1);
      return;
    }
    leave(0);
  };

  const status =
    diliState === "loading" && cityProgress < 1
      ? `Building Dili ${Math.round(cityProgress * 100)}%`
      : !ready
        ? progress > 0
          ? `Loading Cristo Rei ${Math.round(progress * 100)}%`
          : "Loading Cristo Rei"
        : "";

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
          {status && (
            <span className="splash-loading" aria-live="polite">
              {status}
            </span>
          )}
          <button type="button" className="splash-skip" onClick={onSkip}>
            Skip intro
          </button>
        </div>
      </div>
      <div className="splash-greeting">
        <p className="splash-greeting-tetum">Bem-vindu ba Timor-Leste</p>
        <p className="splash-greeting-en">Welcome to Timor-Leste</p>
      </div>
      <div className="splash-veil" aria-hidden="true">
        <p className="splash-veil-caption">Descending over Dili</p>
      </div>
    </div>
  );
}
