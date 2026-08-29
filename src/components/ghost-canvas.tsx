"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The WebGL waiting state: cel-shaded ghosts drifting through a real 3D scene.
 *
 * Each ghost is a solid of revolution — a domed head flowing into a skirt —
 * whose lower vertices are displaced every frame so the hem ripples. That
 * ripple is what makes it read as a cartoon ghost rather than a lathed
 * cylinder, so each ghost owns its own geometry instead of sharing one.
 *
 * three.js arrives through a dynamic `import()` purely so the indicator can
 * paint immediately: the CSS scene behind this draws on the first frame and
 * stays up until WebGL is actually rendering. It is also what anyone with
 * reduced motion, or without a WebGL context, keeps.
 *
 * Everything allocated here is disposed on unmount. three holds geometries,
 * materials, and the GL context outside the garbage collector's reach, and
 * this component mounts on every single load.
 */

const GHOST_COUNT = 5;
const SCENE_HEIGHT = 190;

/** Below this height on the profile the hem is free to ripple. */
const HEM_Y = -0.15;

/** A missing `matchMedia` means no stated preference, never a crash. */
function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Probing for a context is far cheaper than downloading three.js only to find
 * there is nothing to render into — and it keeps the library out of test and
 * server-side environments entirely.
 */
function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export interface GhostCanvasProps {
  /** Lets the CSS scene step aside once WebGL is drawing. */
  onReady?: () => void;
}

export function GhostCanvas({ onReady }: GhostCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (prefersReducedMotion() || !hasWebGL()) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      let THREE: typeof import("three");
      try {
        THREE = await import("three");
      } catch {
        if (!disposed) setFailed(true);
        return;
      }
      if (disposed) return;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      } catch {
        if (!disposed) setFailed(true);
        return;
      }

      const width = host.clientWidth || 520;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, SCENE_HEIGHT, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = `${SCENE_HEIGHT}px`;
      renderer.domElement.style.display = "block";
      host.append(renderer.domElement);

      const scene = new THREE.Scene();
      // Fog does the depth work: far ghosts dissolve toward the page colour.
      scene.fog = new THREE.Fog(0xf4f5f3, 16, 34);

      const camera = new THREE.PerspectiveCamera(40, width / SCENE_HEIGHT, 0.1, 100);
      camera.position.set(0, 0.1, 9.5);

      scene.add(new THREE.AmbientLight(0xffffff, 2.2));
      const key = new THREE.DirectionalLight(0xffffff, 2.6);
      key.position.set(4, 6, 8);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x2563eb, 1.8);
      rim.position.set(-6, -2, 2);
      scene.add(rim);

      /**
       * The silhouette that is spun into a ghost: a dome head, near-straight
       * flanks, then a hem that flares out before closing. The flare is what
       * gives the ripple somewhere to travel.
       */
      function buildProfile(): import("three").Vector2[] {
        const points: import("three").Vector2[] = [];

        for (let step = 0; step <= 18; step += 1) {
          const angle = (step / 18) * Math.PI * 0.5;
          points.push(new THREE.Vector2(Math.sin(angle) * 1.0, Math.cos(angle) * 0.95 + 0.55));
        }

        points.push(new THREE.Vector2(1.0, 0.1));
        points.push(new THREE.Vector2(1.02, -0.4));
        points.push(new THREE.Vector2(1.08, -0.85));
        points.push(new THREE.Vector2(1.14, -1.12));
        points.push(new THREE.Vector2(0.72, -1.24));
        points.push(new THREE.Vector2(0, -1.28));

        /*
         * Lathe winding follows the order of the profile. Built top-down the
         * faces end up pointing inward, which makes `BackSide` the *outer*
         * surface and lets the inverted hull swallow the ghost whole. Running
         * the silhouette bottom-up puts the normals outside, where the outline
         * trick expects them.
         */
        return points.reverse();
      }

      const eyeGeometry = new THREE.SphereGeometry(0.13, 18, 18);
      const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x141b2b });
      const disposables: { dispose(): void }[] = [eyeGeometry, eyeMaterial];

      interface Ghost {
        group: import("three").Group;
        /** The lane this ghost bobs around, so they occupy the scene. */
        baseY: number;
        geometry: import("three").LatheGeometry;
        /** The undeformed positions, so each frame displaces from rest. */
        rest: Float32Array;
        speed: number;
        bob: number;
        phase: number;
        hemSpeed: number;
      }

      const ghosts: Ghost[] = [];

      for (let index = 0; index < GHOST_COUNT; index += 1) {
        const geometry = new THREE.LatheGeometry(buildProfile(), 44);
        /*
         * Opaque on purpose. A translucent body would let the inverted-hull
         * outline behind it show through the whole shape, turning a white
         * ghost grey; distance is carried by the fog instead.
         */
        const material = new THREE.MeshToonMaterial({
          color: index % 2 === 0 ? 0xffffff : 0xeef3ff,
        });
        disposables.push(geometry, material);

        const group = new THREE.Group();
        group.add(new THREE.Mesh(geometry, material));

        /*
         * Inverted hull: the same shape grown slightly and drawn back-faces
         * only, so all that survives is a rim behind the silhouette. It is how
         * cel-shaded characters get their ink line, and without it a white
         * ghost on a near-white page has no edge at all.
         */
        const outlineMaterial = new THREE.MeshBasicMaterial({
          color: 0x141b2b,
          side: THREE.BackSide,
        });
        disposables.push(outlineMaterial);

        const outline = new THREE.Mesh(geometry, outlineMaterial);
        outline.scale.setScalar(1.035);
        group.add(outline);

        for (const side of [-1, 1]) {
          const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
          eye.position.set(side * 0.33, 0.55, 0.9);
          group.add(eye);
        }

        const depth = -index * 1.7;
        const baseY = [0.15, -0.55, 0.6, -0.25, 0.4][index] ?? 0;
        group.position.set(-11 + index * 4.6, baseY, depth);
        group.scale.setScalar(1.05 - index * 0.05);
        scene.add(group);

        const position = geometry.getAttribute("position");
        ghosts.push({
          group,
          baseY,
          geometry,
          rest: Float32Array.from(position.array as Float32Array),
          speed: 1.6 - index * 0.15,
          bob: 0.18 + index * 0.02,
          phase: index * 1.4,
          hemSpeed: 3.2 + index * 0.4,
        });
      }

      const observer = new ResizeObserver(() => {
        const next = host.clientWidth || width;
        camera.aspect = next / SCENE_HEIGHT;
        camera.updateProjectionMatrix();
        renderer.setSize(next, SCENE_HEIGHT, false);
      });
      observer.observe(host);

      // `Clock` is deprecated in three 0.185; `Timer` is the replacement.
      const timer = new THREE.Timer();
      let frame = 0;
      let running = true;

      /** Ripples the hem by pushing its vertices along Y from their rest pose. */
      function rippleHem(ghost: Ghost, time: number): void {
        const position = ghost.geometry.getAttribute("position");
        const array = position.array as Float32Array;

        for (let i = 0; i < array.length; i += 3) {
          const restY = ghost.rest[i + 1];
          if (restY > HEM_Y) continue;

          const restX = ghost.rest[i];
          const restZ = ghost.rest[i + 2];
          const angle = Math.atan2(restZ, restX);
          // Deeper vertices swing further, so the hem flares rather than shears.
          const reach = (HEM_Y - restY) / 1.2;

          array[i + 1] = restY + Math.sin(angle * 3 + time * ghost.hemSpeed) * 0.26 * reach;
        }

        position.needsUpdate = true;
        ghost.geometry.computeVertexNormals();
      }

      function tick(): void {
        timer.update();
        const delta = timer.getDelta();
        const time = timer.getElapsed();

        for (const ghost of ghosts) {
          ghost.group.position.x += ghost.speed * delta;
          if (ghost.group.position.x > 11.5) ghost.group.position.x = -11.5;

          ghost.group.position.y = ghost.baseY + Math.sin(time * 1.3 + ghost.phase) * ghost.bob;
          ghost.group.rotation.y = Math.sin(time * 0.8 + ghost.phase) * 0.5;
          ghost.group.rotation.z = Math.sin(time * 1.05 + ghost.phase) * 0.07;

          rippleHem(ghost, time);
        }

        renderer.render(scene, camera);
        if (running) frame = requestAnimationFrame(tick);
      }

      function onVisibility(): void {
        running = document.visibilityState === "visible";
        if (running) {
          timer.update(); // Drop the time spent hidden.
          frame = requestAnimationFrame(tick);
        } else {
          cancelAnimationFrame(frame);
        }
      }

      document.addEventListener("visibilitychange", onVisibility);
      frame = requestAnimationFrame(tick);
      onReady?.();

      cleanup = () => {
        running = false;
        cancelAnimationFrame(frame);
        document.removeEventListener("visibilitychange", onVisibility);
        observer.disconnect();

        for (const item of disposables) item.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [onReady]);

  if (failed) return null;

  return <div ref={hostRef} className="ghost-canvas" aria-hidden="true" />;
}
