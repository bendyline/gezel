import type { FileMapResponse, MapBlock, MapBuilding } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Camera,
  fitToBounds,
  lodTier,
  rectInView,
  screenToWorldX,
  screenToWorldY,
  zoomAround,
} from './camera.js';
import { render } from './draw.js';
import { geomInView } from './iso/geometry.js';
import {
  type LabelEngineState,
  buildingAnchorScreen,
  createLabelEngineState,
  fitToBoundsIso,
  geometryForModel,
  hitTestIso,
  hitTestIsoBuilding,
  renderIso,
} from './iso/index.js';
import { issueMarkerStyle } from './issue-marker.js';
import { buildPalette } from './palette.js';
import { getSpriteAtlas } from './sprites.js';

/**
 * Canvas city-map renderer. Pure consumer of a `FileMapResponse` (MapModel) — it
 * knows nothing about code, so the same component renders docs/data maps later.
 * Hand-rolled camera (pan/zoom) with viewport culling and three LoD tiers.
 *
 * Two render strategies share the camera and input handling: the V3 isometric
 * city (default) and the legacy flat top-down map (kept as an escape hatch,
 * selectable via the `renderer` prop / localStorage `gezel.mapRenderer`).
 */
export type MapRendererKind = 'iso' | 'flat';

export interface FileMapProps {
  model: FileMapResponse;
  selectedId: string | null;
  /** The second argument identifies the symbol mini-building, when one was hit. */
  onSelect: (block: MapBlock | null, building?: MapBuilding | null) => void;
  /** PR blast radius — blocks that (transitively) import a changed block. */
  affectedIds?: ReadonlySet<string>;
  /** Age lens: color blocks by placement recency instead of language. */
  ageLens?: boolean;
  /** Renderer override; defaults to localStorage 'gezel.mapRenderer' or iso. */
  renderer?: MapRendererKind;
}

export function defaultRenderer(): MapRendererKind {
  try {
    return window.localStorage.getItem('gezel.mapRenderer') === 'flat' ? 'flat' : 'iso';
  } catch {
    return 'iso';
  }
}

function isDarkTheme(el: HTMLElement): boolean {
  return (
    el.closest('[data-theme="dark"]') != null ||
    (!el.closest('[data-theme="light"]') &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  );
}

export function FileMap({
  model,
  selectedId,
  onSelect,
  affectedIds,
  ageLens,
  renderer,
}: FileMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const camRef = useRef<Camera>({ scale: 1, offsetX: 0, offsetY: 0 });
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const rafRef = useRef<number>(0);
  const animationTimeRef = useRef(0);
  const lastAnimationDrawRef = useRef(Number.NEGATIVE_INFINITY);
  const reducedMotionRef = useRef(false);
  const shouldAnimateRef = useRef<() => boolean>(() => false);
  const frameFnRef = useRef<FrameRequestCallback>(() => {});
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** Symbol mini-building under the cursor (iso street zoom) + tooltip anchor. */
  const [hoverSym, setHoverSym] = useState<{
    building: MapBuilding;
    x: number;
    y: number;
  } | null>(null);
  const drawFnRef = useRef<() => void>(() => {});
  const labelStateRef = useRef<LabelEngineState>(createLabelEngineState());
  const mode: MapRendererKind = renderer ?? defaultRenderer();
  const issueBlocks = useMemo(
    () => model.blocks.filter((block) => issueMarkerStyle(block) !== null),
    [model],
  );
  const issueIds = useMemo(() => new Set(issueBlocks.map((block) => block.id)), [issueBlocks]);

  // keep the draw closure current (latest model / palette / selection / hover)
  drawFnRef.current = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { w, h } = sizeRef.current;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const palette = buildPalette(isDarkTheme(canvas));
    const base = {
      cam: camRef.current,
      model,
      palette,
      tier: lodTier(camRef.current.scale),
      viewW: w,
      viewH: h,
      selectedId,
      hoverId,
      atlas: getSpriteAtlas(palette, dpr),
      animationTime: animationTimeRef.current,
      ...(affectedIds ? { affectedIds } : {}),
      ...(ageLens ? { ageLens } : {}),
    };
    if (mode === 'iso') {
      renderIso(ctx, {
        ...base,
        geom: geometryForModel(model),
        labels: labelStateRef.current,
      });
    } else {
      render(ctx, base);
    }
  };

  shouldAnimateRef.current = () => {
    if (
      reducedMotionRef.current ||
      document.visibilityState !== 'visible' ||
      ageLens ||
      issueBlocks.length === 0 ||
      lodTier(camRef.current.scale) === 'city'
    ) {
      return false;
    }
    const { w, h } = sizeRef.current;
    if (mode === 'iso') {
      return geometryForModel(model).geoms.some(
        (geom) => issueIds.has(geom.block.id) && geomInView(camRef.current, geom, w, h),
      );
    }
    return issueBlocks.some((block) => rectInView(camRef.current, block.rect, w, h));
  };

  frameFnRef.current = (time) => {
    rafRef.current = 0;
    const animating = shouldAnimateRef.current();
    // Thirty frames per second is ample for stylized flame/smoke motion and
    // halves the cost of repainting a large canvas compared with raw rAF.
    if (animating && time - lastAnimationDrawRef.current < 1000 / 30) {
      rafRef.current = requestAnimationFrame((nextTime) => frameFnRef.current(nextTime));
      return;
    }
    lastAnimationDrawRef.current = time;
    animationTimeRef.current = reducedMotionRef.current ? 0 : time;
    drawFnRef.current();
    if (shouldAnimateRef.current()) {
      rafRef.current = requestAnimationFrame((nextTime) => frameFnRef.current(nextTime));
    }
  };

  const requestDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame((time) => frameFnRef.current(time));
  }, []);

  // Restart/stop the animation loop as OS motion preference and tab visibility
  // change. A reduced-motion frame is pinned to t=0 instead of slowly drifting
  // whenever another UI interaction happens to redraw the map.
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const syncMotion = () => {
      reducedMotionRef.current = media?.matches ?? false;
      requestDraw();
    };
    const onVisibility = () => requestDraw();
    syncMotion();
    media?.addEventListener('change', syncMotion);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      media?.removeEventListener('change', syncMotion);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [requestDraw]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    },
    [],
  );

  // size to container (DPR-aware) and observe resizes
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const apply = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { w: rect.width, h: rect.height };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      requestDraw();
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(container);
    return () => ro.disconnect();
  }, [requestDraw]);

  // fit the camera whenever a new model arrives
  useEffect(() => {
    const { w, h } = sizeRef.current;
    camRef.current =
      mode === 'iso'
        ? fitToBoundsIso(model.bounds, geometryForModel(model).maxHIso, w || 800, h || 600)
        : fitToBounds(model.bounds, w || 800, h || 600);
    setHoverSym(null);
    requestDraw();
  }, [model, mode, requestDraw]);

  // redraw on selection / hover / lens change (the draw closure reads all)
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps drive the redraw, not the body
  useEffect(() => {
    requestDraw();
  }, [selectedId, hoverId, ageLens, requestDraw]);

  const hitTest = useCallback(
    (sx: number, sy: number): MapBlock | null => {
      const cam = camRef.current;
      if (mode === 'iso') {
        // exact prism picking, front-to-back (tall buildings clickable on
        // their upper floors; short foreground beats tall background)
        return hitTestIso(geometryForModel(model), cam, sx, sy);
      }
      const wx = screenToWorldX(cam, sx);
      const wy = screenToWorldY(cam, sy);
      // topmost block under the point (iterate in reverse: later blocks draw on top)
      for (let i = model.blocks.length - 1; i >= 0; i--) {
        const b = model.blocks[i]!;
        if (
          wx >= b.rect.x &&
          wx <= b.rect.x + b.rect.w &&
          wy >= b.rect.y &&
          wy <= b.rect.y + b.rect.h
        ) {
          return b;
        }
      }
      return null;
    },
    [model, mode],
  );

  const hitTestBuilding = useCallback(
    (block: MapBlock | null, sx: number, sy: number): MapBuilding | null => {
      if (
        !block ||
        mode !== 'iso' ||
        block.state === 'tombstoned' ||
        lodTier(camRef.current.scale) !== 'street'
      ) {
        return null;
      }
      return hitTestIsoBuilding(model, block.id, camRef.current, sx, sy);
    },
    [model, mode],
  );

  // wheel zoom (non-passive so we can preventDefault)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      camRef.current = zoomAround(
        camRef.current,
        factor,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      setHoverSym(null); // anchor is screen-space; a zoom would strand it
      requestDraw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [requestDraw]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY };
    setHoverSym(null);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      dragRef.current = { x: e.clientX, y: e.clientY };
      const cam = camRef.current;
      camRef.current = {
        ...cam,
        offsetX: cam.offsetX - dx / cam.scale,
        offsetY: cam.offsetY - dy / cam.scale,
      };
      requestDraw();
      return;
    }
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = hitTest(sx, sy);
    setHoverId(hit?.id ?? null);
    // Name the function/class under the cursor — only where minis are drawn
    // (iso renderer at street zoom, non-tombstoned symbol-carrying block).
    // Anchored to the building's rooftop, not the cursor, so it sits still.
    const building = hitTestBuilding(hit, sx, sy);
    setHoverSym((prev) => {
      if (!building) return prev === null ? prev : null;
      if (prev?.building === building) return prev;
      const anchor = buildingAnchorScreen(camRef.current, building);
      return { building, x: anchor.x, y: anchor.y };
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const wasDragging = dragRef.current;
    dragRef.current = null;
    // treat a near-zero-movement release as a click (select)
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (wasDragging) {
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const hit = hitTest(sx, sy);
      onSelect(hit, hitTestBuilding(hit, sx, sy));
    }
  };

  return (
    <div ref={containerRef} className="filemap-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="filemap-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHoverId(null);
          setHoverSym(null);
        }}
        style={{
          cursor: dragRef.current ? 'grabbing' : hoverId ? 'pointer' : 'grab',
          touchAction: 'none',
        }}
      />
      {hoverSym && (
        <div className="filemap-symtip" style={{ left: hoverSym.x, top: hoverSym.y }}>
          <strong>{hoverSym.building.label}</strong>
          <span>
            {hoverSym.building.kind}
            {hoverSym.building.lines !== undefined
              ? ` · ${hoverSym.building.lines} ${hoverSym.building.lines === 1 ? 'line' : 'lines'}`
              : ''}
          </span>
        </div>
      )}
    </div>
  );
}
