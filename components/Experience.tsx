"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";
import { CapeWorld } from "@/lib/three/capeWorld";
import { loadCristoRei } from "@/lib/three/cristoRei";
import { detectTier } from "@/lib/three/deviceTier";
import { DESKTOP_SHOTS, MOBILE_SHOTS, mixShots, type ShotId } from "@/lib/shots";
import SplashFlight from "./SplashFlight";

gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText);


type Phase = "intro" | "reveal" | "site";

function detectQuality(): "high" | "low" {
  // Same device tiering as the intro: only the lowest tier gets the lighter landing scene.
  return detectTier().tier === "low" ? "low" : "high";
}

export default function Experience({ children }: { children: React.ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<CapeWorld | null>(null);
  const [phase, setPhase] = useState<Phase>("intro");
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [capeWanted, setCapeWanted] = useState(false);
  const revealedRef = useRef(false);

  // The statue downloads from the first moment, while the intro flies...
  useEffect(() => {
    let cancelled = false;
    loadCristoRei((p) => !cancelled && setProgress(p)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ...but the Cape Fatucama world is only built when the intro draws its cloud
  // curtain, so its main-thread cost never interrupts the flight.
  useEffect(() => {
    if (!capeWanted) return;
    const host = stageRef.current;
    if (!host) return;
    // A fresh canvas per mount: a disposed renderer leaves its context lost, and
    // React may remount this effect (Strict Mode, Fast Refresh).
    const canvas = document.createElement("canvas");
    canvas.className = "stage";
    host.appendChild(canvas);
    let cancelled = false;
    const fail = () => {
      if (cancelled) return;
      setFailed(true);
      setReady(true);
    };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const titleFont = getComputedStyle(document.documentElement).getPropertyValue("--font-display").trim() || "serif";
    const mobile = window.innerWidth < 768;
    const shots = mobile ? MOBILE_SHOTS : DESKTOP_SHOTS;
    let world: CapeWorld;
    try {
      world = new CapeWorld(canvas, shots.hero, { quality: detectQuality(), settings: detectTier(), titleFont, reducedMotion });
    } catch {
      // No WebGL: report it once React has finished this commit.
      queueMicrotask(fail);
      return () => {
        cancelled = true;
        canvas.remove();
      };
    }
    worldRef.current = world;
    // The reveal came first (?intro=0): adopt Dili whenever it is built.
    if (revealedRef.current) world.attachCity(0);
    world
      .load((p) => !cancelled && setProgress(p))
      .then(() => !cancelled && setReady(true))
      .catch(fail);
    const onResize = () => world.resize();
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      world.setPointer((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointer);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      world.dispose();
      worldRef.current = null;
      canvas.remove();
    };
  }, [capeWanted]);
  const onCurtain = useCallback(() => setCapeWanted(true), []);

  // No scrolling while the plane is still in the air.
  useEffect(() => {
    const html = document.documentElement;
    if (phase === "intro") {
      if ("scrollRestoration" in history) history.scrollRestoration = "manual";
      window.scrollTo(0, 0);
      html.classList.add("is-intro");
    } else {
      html.classList.remove("is-intro");
    }
    if (phase !== "intro") worldRef.current?.start();
    return () => html.classList.remove("is-intro");
  }, [phase]);

  // Scroll drives the camera: each section owns a shot, and the scroll position
  // between two section anchors blends their shots.
  useGSAP(
    () => {
      if (phase === "intro") return;
      const root = rootRef.current!;
      const sections = gsap.utils.toArray<HTMLElement>("[data-shot]", root);
      const anchors = sections.map((el, i) =>
        ScrollTrigger.create({ trigger: el, start: i === 0 ? "top top" : "top 60%" }),
      );
      const ease = gsap.parseEase("power2.inOut");
      const apply = (y: number) => {
        const world = worldRef.current;
        if (!world) return;
        const shots = window.innerWidth < 768 ? MOBILE_SHOTS : DESKTOP_SHOTS;
        const ids = sections.map((el) => el.dataset.shot as ShotId);
        const starts = anchors.map((a, i) => (i === 0 ? 0 : a.start));
        let i = 0;
        while (i < starts.length - 1 && y >= starts[i + 1]) i++;
        const next = Math.min(i + 1, starts.length - 1);
        const span = Math.max(1, starts[next] - starts[i]);
        const t = next === i ? 0 : gsap.utils.clamp(0, 1, (y - starts[i]) / span);
        Object.assign(world.target, mixShots(shots[ids[i]], shots[ids[next]], ease(t)));
      };
      const page = ScrollTrigger.create({
        start: 0,
        end: "max",
        onUpdate: (self) => {
          apply(self.scroll());
          root.style.setProperty("--journey", self.progress.toFixed(4));
        },
        onRefresh: (self) => apply(self.scroll()),
      });
      apply(window.scrollY);

      // Timeline rail fills as the history section scrolls past.
      gsap.fromTo(
        ".timeline-rail-fill",
        { scaleY: 0 },
        {
          scaleY: 1,
          ease: "none",
          scrollTrigger: { trigger: ".timeline", start: "top 70%", end: "bottom 60%", scrub: true },
        },
      );
      return () => {
        page.kill();
        anchors.forEach((a) => a.kill());
      };
    },
    { scope: rootRef, dependencies: [phase], revertOnUpdate: true },
  );

  // The one orchestrated entrance: after the clouds part, the camera glides in
  // from far out over the strait and the greeting rises line by line.
  const onReveal = useCallback(async () => {
    revealedRef.current = true;
    const world = worldRef.current;
    if (world) {
      // Behind the veil: adopt the intro's Dili into the home-page scene.
      await world.attachCity();
      Object.assign(world.current, { theta: -38, radius: 34, height: 10, targetY: 5, offset: 0, sunElev: -0.5, title: 0 });
    }
    setPhase("reveal");
  }, []);

  useGSAP(
    () => {
      if (phase !== "reveal" && phase !== "site") return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) return;
      const split = SplitText.create(".hero-title", { type: "lines", mask: "lines" });
      const tl = gsap.timeline({ delay: 0.5 });
      tl.from(split.lines, { yPercent: 110, duration: 1.3, ease: "expo.out", stagger: 0.12 })
        .from(".hero-lede, .hero-cue", { autoAlpha: 0, y: 16, duration: 1, ease: "power2.out", stagger: 0.15 }, "-=0.8");
      return () => split.revert();
    },
    { scope: rootRef, dependencies: [phase === "intro"] },
  );

  return (
    <div ref={rootRef} className="experience">
      <div ref={stageRef} className="stage-host" aria-hidden="true" />
      {failed && (
        <p className="stage-fallback" role="status">
          This browser could not start the 3D scene, so you are seeing the text-only journey.
        </p>
      )}
      <div className="sunrise-dial" aria-hidden="true">
        <span className="sunrise-dial-sun" />
      </div>
      {phase !== "site" && (
        <SplashFlight
          progress={progress}
          ready={ready}
          onCurtain={onCurtain}
          onReveal={onReveal}
          onDone={() => setPhase("site")}
        />
      )}
      <div className="journey" inert={phase === "intro" ? true : undefined}>
        {children}
      </div>
    </div>
  );
}
