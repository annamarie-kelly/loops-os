'use client';

// DesignBoard — freeform whiteboard for UI design review.
// Drop screenshots, draw annotation boxes over elements, attach
// comments. Sequence bar at the bottom lets you order annotations
// to show user flow.
//
// Tools: Select (V) — move cards, pan canvas
//        Box (B)    — draw annotation rectangles

import { useCallback, useEffect, useRef, useState } from 'react';

const LS_BOARD = 'loops-ui:design-board';
const LS_ZOOM = 'loops-ui:design-board-zoom';
const LS_SAVED = 'loops-ui:design-board-saved';

interface BoardCard {
  id: string;
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  caption: string;
  addedAt: string;
}

interface Annotation {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  comment: string;
  color: string;
  createdAt: string;
}

type BoardState = {
  cards: BoardCard[];
  annotations: Annotation[];
};

interface SavedBoard {
  id: string;
  imgPath: string;
  date: string;
  annotations: { comment: string; color: string }[];
  fixed: boolean;
  thumbnail?: string; // small data URL for preview
}

const ANNOTATION_COLORS = [
  { value: 'rose', label: 'Rose', fill: 'rgba(224,132,140,0.12)', border: 'rgba(224,132,140,0.6)' },
  { value: 'sage', label: 'Sage', fill: 'rgba(139,154,139,0.12)', border: 'rgba(139,154,139,0.6)' },
  { value: 'ocean', label: 'Ocean', fill: 'rgba(122,154,160,0.12)', border: 'rgba(122,154,160,0.6)' },
  { value: 'tan', label: 'Tan', fill: 'rgba(196,132,122,0.12)', border: 'rgba(196,132,122,0.6)' },
];

const DEFAULT_MAX_W = 300;
const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

type Tool = 'select' | 'box';

export function DesignBoard({
  onFix,
}: {
  onFix?: (imgPath: string, annotations: { index: number; comment: string }[], captions: string[]) => void;
}) {
  const [board, setBoard] = useState<BoardState>({ cards: [], annotations: [] });
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool>('select');
  const [dragging, setDragging] = useState<{ startX: number; startY: number } | null>(null);
  const [drawing, setDrawing] = useState<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const [panning, setPanning] = useState<{ startX: number; startY: number; scrollX: number; scrollY: number } | null>(null);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Keep a single "focused" annotation for comment editing / color picking
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const [annotationColor, setAnnotationColor] = useState(0);
  const [seqDragging, setSeqDragging] = useState<{ idx: number; overIdx: number } | null>(null);
  const [savedBoards, setSavedBoards] = useState<SavedBoard[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Load state
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_BOARD);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed)) {
            setBoard({ cards: parsed, annotations: [] });
          } else {
            setBoard({
              cards: parsed.cards ?? [],
              annotations: parsed.annotations ?? [],
            });
          }
        }
      }
      const rawZoom = localStorage.getItem(LS_ZOOM);
      if (rawZoom) {
        const z = parseFloat(rawZoom);
        if (Number.isFinite(z) && z > 0) setZoom(z);
      }
      const rawSaved = localStorage.getItem(LS_SAVED);
      if (rawSaved) {
        try { setSavedBoards(JSON.parse(rawSaved)); } catch {}
      }
    } catch {}
  }, []);

  // On first load, scroll so content is visible (not lost in top-left of huge canvas)
  const didInitScroll = useRef(false);
  useEffect(() => {
    if (didInitScroll.current) return;
    const el = canvasRef.current;
    if (!el || (board.cards.length === 0 && board.annotations.length === 0)) return;
    didInitScroll.current = true;
    // Find bounding box of all content
    const allX = [...board.cards.map((c) => c.x), ...board.annotations.map((a) => a.x)];
    const allY = [...board.cards.map((c) => c.y), ...board.annotations.map((a) => a.y)];
    const allR = [...board.cards.map((c) => c.x + c.width), ...board.annotations.map((a) => a.x + a.width)];
    const allB = [...board.cards.map((c) => c.y + c.height), ...board.annotations.map((a) => a.y + a.height)];
    const minX = Math.min(...allX);
    const minY = Math.min(...allY);
    const maxX = Math.max(...allR);
    const maxY = Math.max(...allB);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const rect = el.getBoundingClientRect();
    el.scrollLeft = centerX * zoom - rect.width / 2;
    el.scrollTop = centerY * zoom - rect.height / 2;
  }, [board, zoom]);

  const persist = useCallback((updated: BoardState) => {
    try { localStorage.setItem(LS_BOARD, JSON.stringify(updated)); } catch {}
  }, []);

  const updateBoard = useCallback((updater: (prev: BoardState) => BoardState) => {
    setBoard((prev) => {
      const next = updater(prev);
      persist(next);
      return next;
    });
  }, [persist]);

  // Zoom while keeping the viewport center stable.
  const applyZoom = useCallback((newZoom: number) => {
    const el = canvasRef.current;
    if (el) {
      const oldZoom = zoom;
      const rect = el.getBoundingClientRect();
      // Center of viewport in canvas-space (before zoom change)
      const cx = (el.scrollLeft + rect.width / 2) / oldZoom;
      const cy = (el.scrollTop + rect.height / 2) / oldZoom;
      setZoom(newZoom);
      // After React re-renders with new zoom, adjust scroll so same
      // canvas point stays at viewport center.
      requestAnimationFrame(() => {
        el.scrollLeft = cx * newZoom - rect.width / 2;
        el.scrollTop = cy * newZoom - rect.height / 2;
      });
    } else {
      setZoom(newZoom);
    }
    try { localStorage.setItem(LS_ZOOM, String(newZoom)); } catch {}
  }, [zoom]);

  const setZoomPersist = applyZoom;

  const zoomIn = useCallback(() => {
    const idx = ZOOM_LEVELS.findIndex((z) => z >= zoom);
    applyZoom(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, idx + 1)] ?? zoom);
  }, [zoom, applyZoom]);

  const zoomOut = useCallback(() => {
    const idx = ZOOM_LEVELS.findIndex((z) => z >= zoom);
    applyZoom(ZOOM_LEVELS[Math.max(0, idx - 1)] ?? zoom);
  }, [zoom, applyZoom]);

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: (clientX - rect.left + el.scrollLeft) / zoom,
      y: (clientY - rect.top + el.scrollTop) / zoom,
    };
  }, [zoom]);

  // ── File drop ──
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropHover(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    const { x: baseX, y: baseY } = toCanvas(e.clientX, e.clientY);
    files.forEach((file, i) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, DEFAULT_MAX_W / img.naturalWidth);
          updateBoard((prev) => ({
            ...prev,
            cards: [...prev.cards, {
              id: genId(), dataUrl, x: baseX + i * 20, y: baseY + i * 20,
              width: Math.round(img.naturalWidth * scale),
              height: Math.round(img.naturalHeight * scale),
              caption: '', addedAt: new Date().toISOString(),
            }],
          }));
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
  }, [updateBoard, toCanvas]);

  // Helper: check if item overlaps a rect
  const overlaps = (item: { x: number; y: number; width: number; height: number }, rect: { x: number; y: number; w: number; h: number }) =>
    item.x < rect.x + rect.w && item.x + item.width > rect.x &&
    item.y < rect.y + rect.h && item.y + item.height > rect.y;

  // ── Item click (card or annotation) — select, then drag moves all selected ──
  const handleItemMouseDown = useCallback((e: React.MouseEvent, itemId: string) => {
    if (tool !== 'select') return;
    e.stopPropagation();
    e.preventDefault();

    // If item isn't selected, select it (replace selection unless shift)
    if (!selected.has(itemId)) {
      if (e.shiftKey) {
        setSelected((prev) => new Set([...prev, itemId]));
      } else {
        setSelected(new Set([itemId]));
      }
    }

    const { x, y } = toCanvas(e.clientX, e.clientY);
    setDragging({ startX: x, startY: y });
    setSelectedAnnotation(itemId);
  }, [tool, selected, toCanvas]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (panning) {
      const el = canvasRef.current;
      if (el) {
        el.scrollLeft = panning.scrollX - (e.clientX - panning.startX);
        el.scrollTop = panning.scrollY - (e.clientY - panning.startY);
      }
      return;
    }
    if (dragging && selected.size > 0) {
      const { x, y } = toCanvas(e.clientX, e.clientY);
      const dx = x - dragging.startX;
      const dy = y - dragging.startY;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        updateBoard((prev) => ({
          ...prev,
          cards: prev.cards.map((c) =>
            selected.has(c.id) ? { ...c, x: Math.max(0, c.x + dx), y: Math.max(0, c.y + dy) } : c,
          ),
          annotations: prev.annotations.map((a) =>
            selected.has(a.id) ? { ...a, x: Math.max(0, a.x + dx), y: Math.max(0, a.y + dy) } : a,
          ),
        }));
        setDragging({ startX: x, startY: y });
      }
      return;
    }
    if (marquee) {
      const { x, y } = toCanvas(e.clientX, e.clientY);
      setMarquee((prev) => prev ? { ...prev, curX: x, curY: y } : null);
      return;
    }
    if (drawing) {
      const { x, y } = toCanvas(e.clientX, e.clientY);
      setDrawing((prev) => prev ? { ...prev, curX: x, curY: y } : null);
    }
  }, [panning, dragging, marquee, drawing, selected, toCanvas, updateBoard]);

  const handleMouseUp = useCallback(() => {
    if (panning) { setPanning(null); return; }
    if (dragging) { setDragging(null); return; }
    if (marquee) {
      const rect = {
        x: Math.min(marquee.startX, marquee.curX),
        y: Math.min(marquee.startY, marquee.curY),
        w: Math.abs(marquee.curX - marquee.startX),
        h: Math.abs(marquee.curY - marquee.startY),
      };
      if (rect.w > 5 && rect.h > 5) {
        const sel = new Set<string>();
        for (const c of board.cards) { if (overlaps(c, rect)) sel.add(c.id); }
        for (const a of board.annotations) { if (overlaps(a, rect)) sel.add(a.id); }
        setSelected(sel);
      }
      setMarquee(null);
      return;
    }
    if (drawing) {
      const w = Math.abs(drawing.curX - drawing.startX);
      const h = Math.abs(drawing.curY - drawing.startY);
      if (w > 10 && h > 10) {
        const id = genId();
        const color = ANNOTATION_COLORS[annotationColor].value;
        updateBoard((prev) => ({
          ...prev,
          annotations: [...prev.annotations, {
            id,
            x: Math.min(drawing.startX, drawing.curX),
            y: Math.min(drawing.startY, drawing.curY),
            width: w, height: h, comment: '', color,
            createdAt: new Date().toISOString(),
          }],
        }));
        setSelectedAnnotation(id);
        setEditingComment(id);
        setSelected(new Set([id]));
      }
      setDrawing(null);
    }
  }, [panning, dragging, marquee, drawing, board, annotationColor, updateBoard]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (tool === 'box') {
      e.preventDefault();
      const { x, y } = toCanvas(e.clientX, e.clientY);
      setDrawing({ startX: x, startY: y, curX: x, curY: y });
      setSelectedAnnotation(null);
      setEditingComment(null);
      setSelected(new Set());
      return;
    }

    // Select mode: clicking empty space starts a marquee selection
    const target = e.target as HTMLElement;
    if (target.closest('[data-card]') || target.closest('[data-annotation]')) return;

    e.preventDefault();
    const { x, y } = toCanvas(e.clientX, e.clientY);
    setMarquee({ startX: x, startY: y, curX: x, curY: y });
    setSelectedAnnotation(null);
    setEditingComment(null);
    if (!e.shiftKey) setSelected(new Set());
  }, [tool, toCanvas]);

  const removeCard = useCallback((id: string) => {
    updateBoard((prev) => ({ ...prev, cards: prev.cards.filter((c) => c.id !== id) }));
  }, [updateBoard]);

  const removeAnnotation = useCallback((id: string) => {
    updateBoard((prev) => ({
      ...prev,
      annotations: prev.annotations.filter((a) => a.id !== id),
    }));
    if (selectedAnnotation === id) setSelectedAnnotation(null);
    if (editingComment === id) setEditingComment(null);
  }, [updateBoard, selectedAnnotation, editingComment]);

  const updateComment = useCallback((id: string, comment: string) => {
    updateBoard((prev) => ({
      ...prev,
      annotations: prev.annotations.map((a) => a.id === id ? { ...a, comment } : a),
    }));
    setEditingComment(null);
  }, [updateBoard]);

  const updateCaption = useCallback((id: string, caption: string) => {
    updateBoard((prev) => ({
      ...prev,
      cards: prev.cards.map((c) => c.id === id ? { ...c, caption } : c),
    }));
  }, [updateBoard]);

  // ── Sequence bar: drag to reorder ──
  const handleSeqDragStart = useCallback((idx: number) => {
    setSeqDragging({ idx, overIdx: idx });
  }, []);

  const handleSeqDragOver = useCallback((overIdx: number) => {
    setSeqDragging((prev) => prev ? { ...prev, overIdx } : null);
  }, []);

  const handleSeqDrop = useCallback(() => {
    if (!seqDragging || seqDragging.idx === seqDragging.overIdx) {
      setSeqDragging(null);
      return;
    }
    const { idx, overIdx } = seqDragging;
    updateBoard((prev) => {
      const anns = [...prev.annotations];
      const [moved] = anns.splice(idx, 1);
      anns.splice(overIdx, 0, moved);
      return { ...prev, annotations: anns };
    });
    setSeqDragging(null);
  }, [seqDragging, updateBoard]);

  // ── Paste handling ──
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.type.startsWith('image/'));
      if (!imageItem) return;
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, DEFAULT_MAX_W / img.naturalWidth);
          updateBoard((prev) => ({
            ...prev,
            cards: [...prev.cards, {
              id: genId(), dataUrl,
              x: 40 + (prev.cards.length % 5) * 30,
              y: 40 + (prev.cards.length % 5) * 30,
              width: Math.round(img.naturalWidth * scale),
              height: Math.round(img.naturalHeight * scale),
              caption: '', addedAt: new Date().toISOString(),
            }],
          }));
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    };
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, [updateBoard]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if (e.key === 'v' && !e.metaKey) { setTool('select'); return; }
      if (e.key === 'b' && !e.metaKey) { setTool('box'); return; }
      if ((e.key === '=' || e.key === '+') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); zoomIn(); return; }
      if (e.key === '-' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); zoomOut(); return; }
      if (e.key === '0' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setZoomPersist(1); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (selected.size > 0) {
          updateBoard((prev) => ({
            ...prev,
            cards: prev.cards.filter((c) => !selected.has(c.id)),
            annotations: prev.annotations.filter((a) => !selected.has(a.id)),
          }));
          setSelected(new Set());
          setSelectedAnnotation(null);
          setEditingComment(null);
        } else if (selectedAnnotation) {
          removeAnnotation(selectedAnnotation);
        }
      }
      if (e.key === 'Escape') {
        setSelectedAnnotation(null);
        setEditingComment(null);
        setTool('select');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedAnnotation, zoomIn, zoomOut, setZoomPersist, removeAnnotation]);

  // Wheel zoom
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [zoomIn, zoomOut]);

  const persistSaved = useCallback((boards: SavedBoard[]) => {
    try { localStorage.setItem(LS_SAVED, JSON.stringify(boards)); } catch {}
  }, []);

  const addSavedBoard = useCallback((entry: SavedBoard) => {
    setSavedBoards((prev) => {
      const next = [entry, ...prev];
      persistSaved(next);
      return next;
    });
  }, [persistSaved]);

  const toggleFixed = useCallback((id: string) => {
    setSavedBoards((prev) => {
      const next = prev.map((b) => b.id === id ? { ...b, fixed: !b.fixed } : b);
      persistSaved(next);
      return next;
    });
  }, [persistSaved]);

  const removeSavedBoard = useCallback((id: string) => {
    setSavedBoards((prev) => {
      const board = prev.find((b) => b.id === id);
      if (board?.imgPath) {
        // Delete PNG and companion .md from vault
        const del = (file: string) => fetch('/api/vault/write', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file }),
        }).catch(() => {});
        del(board.imgPath);
        del(board.imgPath.replace('.png', '.md'));
      }
      const next = prev.filter((b) => b.id !== id);
      persistSaved(next);
      return next;
    });
  }, [persistSaved]);

  // ── Save: render board as PNG to vault (no chat) ──
  // Shared renderer used by both Save and Fix — returns the image path
  const renderAndSave = useCallback(async (): Promise<{ imgPath: string; annSummary: { index: number; comment: string }[]; captions: string[] } | null> => {
    if (board.cards.length === 0 && board.annotations.length === 0) return null;

    const today = new Date().toISOString().slice(0, 10);
    const ts = Date.now().toString(36);
    const boardName = `Design Review ${today}`;
    const imgFile = `01-Creating/design-boards/${boardName}-${ts}.png`;

    // Find bounding box
    const allItems = [
      ...board.cards.map((c) => ({ x: c.x, y: c.y, r: c.x + c.width, b: c.y + c.height })),
      ...board.annotations.map((a) => ({ x: a.x, y: a.y, r: a.x + a.width, b: a.y + a.height + 60 })),
    ];
    if (allItems.length === 0) return null;

    const pad = 40;
    const minX = Math.min(...allItems.map((i) => i.x)) - pad;
    const minY = Math.min(...allItems.map((i) => i.y)) - pad;
    const maxX = Math.max(...allItems.map((i) => i.r)) + pad;
    const maxY = Math.max(...allItems.map((i) => i.b)) + pad;
    const cw = maxX - minX;
    const ch = maxY - minY;

    const canvas = document.createElement('canvas');
    canvas.width = cw * 2;
    canvas.height = ch * 2;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(2, 2);

    ctx.fillStyle = '#F5F0EB';
    ctx.fillRect(0, 0, cw, ch);

    ctx.fillStyle = 'rgba(45,42,38,0.04)';
    for (let gx = 0; gx < cw; gx += 24) {
      for (let gy = 0; gy < ch; gy += 24) {
        ctx.beginPath();
        ctx.arc(gx, gy, 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const loadImage = (src: string): Promise<HTMLImageElement> =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(img);
        img.src = src;
      });

    const cardImages = await Promise.all(board.cards.map((c) => loadImage(c.dataUrl)));

    for (let i = 0; i < board.cards.length; i++) {
      const card = board.cards[i];
      const img = cardImages[i];
      const x = card.x - minX;
      const y = card.y - minY;

      ctx.shadowColor = 'rgba(0,0,0,0.08)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = '#FFFCF9';
      ctx.beginPath();
      ctx.roundRect(x, y, card.width, card.height + 28, 8);
      ctx.fill();
      ctx.shadowColor = 'transparent';

      ctx.strokeStyle = 'rgba(45,42,38,0.1)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, card.width, card.height + 28, 8);
      ctx.stroke();

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, card.width, card.height, [8, 8, 0, 0]);
      ctx.clip();
      ctx.drawImage(img, x, y, card.width, card.height);
      ctx.restore();

      if (card.caption) {
        ctx.fillStyle = 'rgba(45,42,38,0.4)';
        ctx.font = '10px -apple-system, system-ui, sans-serif';
        ctx.fillText(card.caption, x + 8, y + card.height + 18, card.width - 16);
      }
    }

    const colorMap: Record<string, { fill: string; border: string }> = {};
    for (const c of ANNOTATION_COLORS) {
      colorMap[c.value] = { fill: c.fill, border: c.border };
    }

    for (let i = 0; i < board.annotations.length; i++) {
      const ann = board.annotations[i];
      const x = ann.x - minX;
      const y = ann.y - minY;
      const colors = colorMap[ann.color] ?? ANNOTATION_COLORS[0];

      ctx.fillStyle = colors.fill;
      ctx.strokeStyle = colors.border;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.roundRect(x, y, ann.width, ann.height, 4);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = colors.border;
      ctx.beginPath();
      ctx.arc(x - 2, y - 2, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), x - 2, y + 1);
      ctx.textAlign = 'left';

      if (ann.comment) {
        const bx = x;
        const by = y + ann.height + 4;
        ctx.font = '11px -apple-system, system-ui, sans-serif';
        const maxBw = Math.min(Math.max(ann.width, 160), 280);
        const innerW = maxBw - 16;
        const lineHeight = 15;
        const words = ann.comment.split(' ');
        const wrappedLines: string[] = [];
        let currentLine = '';
        for (const word of words) {
          const test = currentLine ? `${currentLine} ${word}` : word;
          if (ctx.measureText(test).width > innerW && currentLine) {
            wrappedLines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = test;
          }
        }
        if (currentLine) wrappedLines.push(currentLine);
        const bw = wrappedLines.length === 1
          ? Math.min(Math.max(ctx.measureText(wrappedLines[0]).width + 16, 80), maxBw)
          : maxBw;
        const bh = wrappedLines.length * lineHeight + 14;

        ctx.shadowColor = 'rgba(0,0,0,0.06)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle = '#FFFCF9';
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 6);
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = 'rgba(45,42,38,0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 6);
        ctx.stroke();
        ctx.fillStyle = '#2D2A26';
        for (let li = 0; li < wrappedLines.length; li++) {
          ctx.fillText(wrappedLines[li], bx + 8, by + 14 + li * lineHeight, bw - 16);
        }
      }
    }

    const pngDataUrl = canvas.toDataURL('image/png');
    const base64Data = pngDataUrl.split(',')[1];

    await fetch('/api/vault/write', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: imgFile, content: base64Data, encoding: 'base64' }),
    });

    const annSummary = board.annotations.map((ann, i) => ({
      index: i + 1,
      comment: ann.comment.trim(),
    }));

    // Write companion markdown with captions and annotations
    const mdFile = imgFile.replace('.png', '.md');
    const captionLines = board.cards
      .filter((c) => c.caption.trim())
      .map((c, i) => `- [ ] **${i + 1}.** ${c.caption.trim()}`);
    const annLines = annSummary
      .filter((a) => a.comment)
      .map((a) => `- **Note ${a.index}:** ${a.comment}`);
    const mdParts = [
      `![[${imgFile.split('/').pop()}]]`,
      '',
    ];
    if (captionLines.length > 0) {
      mdParts.push('## Captions', ...captionLines, '');
    }
    if (annLines.length > 0) {
      mdParts.push('## Annotations', ...annLines, '');
    }
    await fetch('/api/vault/write', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: mdFile, content: mdParts.join('\n') }),
    });

    // Generate small thumbnail for history preview
    const thumbCanvas = document.createElement('canvas');
    const thumbScale = Math.min(200 / cw, 120 / ch, 1);
    thumbCanvas.width = Math.round(cw * thumbScale);
    thumbCanvas.height = Math.round(ch * thumbScale);
    const thumbCtx = thumbCanvas.getContext('2d')!;
    thumbCtx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumbnail = thumbCanvas.toDataURL('image/png', 0.6);

    // Add to saved boards
    addSavedBoard({
      id: ts,
      imgPath: imgFile,
      date: today,
      annotations: board.annotations.map((a) => ({ comment: a.comment, color: a.color })),
      fixed: false,
      thumbnail,
    });

    const captions = board.cards.map((c) => c.caption.trim()).filter(Boolean);
    return { imgPath: imgFile, annSummary, captions };
  }, [board, addSavedBoard]);

  // ── Fix: save + open chat for analysis ──
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);

  const handleSave = useCallback(async () => {
    setExporting(true);
    try {
      await renderAndSave();
      setExported(true);
      setTimeout(() => setExported(false), 3000);
    } catch (err) {
      console.error('Save failed', err);
    } finally {
      setExporting(false);
    }
  }, [renderAndSave]);

  const handleFix = useCallback(async () => {
    setExporting(true);
    try {
      const result = await renderAndSave();
      setExported(true);
      setTimeout(() => setExported(false), 3000);
      if (result && onFix) {
        onFix(result.imgPath, result.annSummary, result.captions);
      }
    } catch (err) {
      console.error('Fix failed', err);
    } finally {
      setExporting(false);
    }
  }, [renderAndSave, onFix]);

  const { cards, annotations } = board;
  const zoomPct = Math.round(zoom * 100);

  // Large canvas that grows as content is placed — feels infinite.
  // Always at least 4000x3000 so there's room to pan in every direction.
  const canvasW = Math.max(4000, ...cards.map((c) => c.x + c.width + 500), ...annotations.map((a) => a.x + a.width + 500));
  const canvasH = Math.max(3000, ...cards.map((c) => c.y + c.height + 500), ...annotations.map((a) => a.y + a.height + 500));

  const drawRect = drawing ? {
    x: Math.min(drawing.startX, drawing.curX),
    y: Math.min(drawing.startY, drawing.curY),
    w: Math.abs(drawing.curX - drawing.startX),
    h: Math.abs(drawing.curY - drawing.startY),
  } : null;

  const colorForValue = (v: string) => ANNOTATION_COLORS.find((c) => c.value === v) ?? ANNOTATION_COLORS[0];

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="px-4 py-2.5 border-b border-edge shrink-0">
        <div className="flex items-center gap-4">
          {/* Zoom controls — left */}
          <div className="flex items-center gap-1 text-[11px]">
            <button type="button" onClick={zoomOut}
              className="w-6 h-6 rounded flex items-center justify-center text-ink-ghost hover:text-ink hover:bg-inset transition-colors"
              title="Zoom out (⌘-)">−</button>
            <button type="button" onClick={() => setZoomPersist(1)}
              className="min-w-[3rem] text-center text-ink-ghost hover:text-ink tabular-nums cursor-pointer"
              title="Reset zoom (⌘0)">{zoomPct}%</button>
            <button type="button" onClick={zoomIn}
              className="w-6 h-6 rounded flex items-center justify-center text-ink-ghost hover:text-ink hover:bg-inset transition-colors"
              title="Zoom in (⌘+)">+</button>
          </div>

          <div className="w-px h-4 bg-edge" />

          {/* Tool selector — center */}
          <div className="flex items-center gap-0 rounded-md bg-inset p-0.5">
            <button
              type="button"
              onClick={() => setTool('select')}
              className={`px-2.5 py-1 rounded text-[11px] transition-all ${
                tool === 'select'
                  ? 'bg-card text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-ink-soft hover:text-ink'
              }`}
              title="Select / Move (V)"
            >
              Select
            </button>
            <button
              type="button"
              onClick={() => setTool('box')}
              className={`px-2.5 py-1 rounded text-[11px] transition-all ${
                tool === 'box'
                  ? 'bg-card text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-ink-soft hover:text-ink'
              }`}
              title="Annotate — draw boxes (B)"
            >
              Annotate
            </button>
          </div>

          {/* Color picker */}
          {(tool === 'box' || selectedAnnotation) && (
            <div className="flex items-center gap-2.5">
              {ANNOTATION_COLORS.map((c, i) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => {
                    setAnnotationColor(i);
                    if (selectedAnnotation) {
                      updateBoard((prev) => ({
                        ...prev,
                        annotations: prev.annotations.map((a) =>
                          a.id === selectedAnnotation ? { ...a, color: c.value } : a,
                        ),
                      }));
                    }
                  }}
                  className={`w-5 h-5 rounded-full transition-all ${
                    annotationColor === i ? 'ring-2 ring-offset-2 ring-[var(--slate)] scale-125' : 'hover:scale-110'
                  }`}
                  style={{ background: c.border }}
                  title={c.label}
                />
              ))}
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* History toggle */}
          <button
            type="button"
            onClick={() => setShowSaved((v) => !v)}
            className={`px-2.5 py-1 rounded-md text-[11px] transition-all border ${
              showSaved
                ? 'bg-inset text-ink border-edge'
                : savedBoards.length > 0
                  ? 'text-ink-soft border-transparent hover:text-ink'
                  : 'text-ink-ghost border-transparent opacity-50'
            }`}
            title={savedBoards.length > 0 ? 'Show saved boards' : 'No saved boards yet'}
          >
            History{savedBoards.length > 0 ? ` (${savedBoards.length})` : ''}
          </button>

          {/* Save + Fix — right */}
          {(cards.length > 0 || annotations.length > 0) && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleSave}
                disabled={exporting}
                className={`px-3 py-1 rounded-md text-[11px] font-medium transition-all border ${
                  exported
                    ? 'bg-sage-fill text-sage-text border-[var(--sage)]'
                    : exporting
                      ? 'bg-inset text-ink-ghost border-edge'
                      : 'bg-card text-ink-soft border-edge hover:text-ink hover:border-edge-hover shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                }`}
                title="Save board image to vault"
              >
                {exported ? 'Saved' : exporting ? '...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={handleFix}
                disabled={exporting}
                className="px-3 py-1 rounded-md text-[11px] font-medium transition-all border bg-card text-ink border-edge hover:border-edge-hover shadow-[0_1px_2px_rgba(0,0,0,0.04)] disabled:opacity-40"
                title="Save and analyze with Claude"
              >
                Fix
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Saved boards history */}
      {showSaved && (
        <div className="border-b border-edge bg-page px-4 py-3 shrink-0 max-h-[280px] overflow-y-auto scrollbar-subtle">
          {savedBoards.length === 0 && (
            <p className="text-[11px] text-ink-ghost italic py-2">No saved boards yet. Hit Save to capture your first one.</p>
          )}
          <div className="space-y-3">
            {savedBoards.map((sb) => {
              const comments = sb.annotations.filter((a) => a.comment);
              const annList = comments.map((a, i) => `${i + 1}. ${a.comment}`).join('\n');
              const clipboardCmd = `/annotation-intake ${sb.imgPath}\n\nAnnotations:\n${annList}`;
              return (
                <div
                  key={sb.id}
                  className={`rounded-lg border transition-colors ${
                    sb.fixed ? 'border-edge-subtle opacity-50' : 'border-edge'
                  }`}
                >
                  <div className="flex gap-3 p-2.5">
                    {/* Thumbnail — inline data URL or loaded from vault */}
                    <img
                      src={sb.thumbnail || `/api/vault/image?file=${encodeURIComponent(sb.imgPath)}`}
                      alt={`Board ${sb.date}`}
                      className={`shrink-0 rounded border border-edge-subtle object-cover bg-inset ${sb.fixed ? 'grayscale' : ''}`}
                      style={{ width: 80, height: 56 }}
                    />

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggleFixed(sb.id)}
                          className={`shrink-0 w-3.5 h-3.5 rounded border transition-colors ${
                            sb.fixed ? 'bg-[var(--sage)] border-[var(--sage)]' : 'border-edge hover:border-edge-hover'
                          }`}
                          title={sb.fixed ? 'Mark unfixed' : 'Mark fixed'}
                        >
                          {sb.fixed && <span className="text-white text-[8px] flex items-center justify-center">&#10003;</span>}
                        </button>
                        <span className={`text-[11px] font-medium ${sb.fixed ? 'text-ink-ghost line-through' : 'text-ink'}`}>
                          {sb.date}
                        </span>
                        <span className="text-[10px] text-ink-ghost">
                          {comments.length} note{comments.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {comments.length > 0 && (
                        <div className="mt-1 text-[10px] text-ink-ghost leading-snug line-clamp-2">
                          {comments.map((a, i) => (
                            <span key={i}>{i > 0 ? ' · ' : ''}{a.comment}</span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="shrink-0 flex flex-col gap-1 items-end">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(clipboardCmd);
                        }}
                        className="text-[9px] text-ink-ghost hover:text-ink-soft px-1.5 py-0.5 rounded hover:bg-inset transition-colors"
                        title="Copy prompt — paste into Claude Code"
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        onClick={() => removeSavedBoard(sb.id)}
                        className="text-[9px] text-ink-ghost hover:text-rose-text px-1.5 py-0.5 rounded transition-colors"
                        title="Remove"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Canvas */}
      <div
        ref={canvasRef}
        className={`flex-1 min-h-0 min-w-0 overflow-scroll relative ${
          panning ? 'cursor-grabbing' : tool === 'box' ? 'cursor-crosshair' : 'cursor-grab'
        } transition-colors ${
          dropHover ? 'bg-sage-fill/30 ring-2 ring-inset ring-[var(--sage)]' : 'bg-inset'
        }`}
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropHover(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDropHover(false); }}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { setDragging(null); setDrawing(null); setPanning(null); setMarquee(null); }}
      >
        <div style={{ width: canvasW * zoom, height: canvasH * zoom }}>
          <div
            className="relative origin-top-left"
            style={{ transform: `scale(${zoom})`, width: canvasW, height: canvasH }}
          >
            {/* Grid background */}
            <div
              className="absolute inset-0 pointer-events-none opacity-[0.04]"
              style={{
                backgroundImage: 'radial-gradient(circle, var(--text-ink) 1px, transparent 1px)',
                backgroundSize: '24px 24px',
              }}
            />

            {/* Empty state */}
            {cards.length === 0 && !dropHover && (
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-edge flex items-center justify-center mb-4">
                  <span className="text-[24px] text-ink-ghost">+</span>
                </div>
                <p className="text-[13px] text-ink-ghost">Drop screenshots here</p>
                <p className="text-[11px] text-ink-ghost mt-1">paste (⌘V) or drag files · B to annotate</p>
              </div>
            )}

            {dropHover && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-50">
                <div className="bg-card border border-[var(--sage)] rounded-xl px-6 py-4 shadow-lg">
                  <p className="text-[13px] text-sage-text font-medium">Drop to add to board</p>
                </div>
              </div>
            )}

            {/* Image cards */}
            {cards.map((card) => (
              <div
                key={card.id}
                data-card
                className={`absolute group/card ${
                  dragging && selected.has(card.id) ? 'z-40 cursor-grabbing' : tool === 'select' ? 'z-10 cursor-grab' : 'z-10'
                }`}
                style={{ left: card.x, top: card.y, width: card.width }}
              >
                <div
                  className={`rounded-lg overflow-hidden border bg-card shadow-[0_2px_8px_rgba(0,0,0,0.06)] transition-shadow hover:shadow-[0_4px_16px_rgba(0,0,0,0.1)] ${
                    selected.has(card.id)
                      ? 'border-[var(--slate)] shadow-[0_4px_16px_rgba(0,0,0,0.1)] ring-2 ring-[var(--slate)]/30'
                      : 'border-edge'
                  }`}
                >
                  <div
                    onMouseDown={(e) => handleItemMouseDown(e, card.id)}
                    className="select-none"
                  >
                    <img
                      src={card.dataUrl}
                      alt={card.caption || 'Design reference'}
                      className="w-full h-auto block pointer-events-none"
                      draggable={false}
                    />
                  </div>
                  <div className="px-2 py-1.5 border-t border-edge-subtle flex items-center gap-1 min-h-[28px]">
                    <input
                      type="text"
                      value={card.caption}
                      onChange={(e) => updateCaption(card.id, e.target.value)}
                      className="flex-1 text-[10px] bg-transparent text-ink-ghost hover:text-ink-soft focus:text-ink placeholder:text-ink-ghost/50 focus:outline-none min-w-0"
                      placeholder="Caption..."
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    />
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeCard(card.id); }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="shrink-0 w-5 h-5 rounded flex items-center justify-center text-[11px] text-ink-ghost opacity-0 group-hover/card:opacity-60 hover:!opacity-100 hover:bg-rose-fill hover:text-rose-text transition-all"
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {/* Annotations */}
            {annotations.map((ann, annIdx) => {
              const colorDef = colorForValue(ann.color);
              const isSelected = selectedAnnotation === ann.id;
              const isInSelection = selected.has(ann.id);
              const isEditing = editingComment === ann.id;
              return (
                <div
                  key={ann.id}
                  data-annotation
                  className={`absolute z-30 ${tool === 'select' ? 'cursor-pointer' : ''}`}
                  style={{ left: ann.x, top: ann.y, width: ann.width, height: ann.height }}
                  onClick={(e) => { e.stopPropagation(); setSelectedAnnotation(ann.id); }}
                  onDoubleClick={(e) => { e.stopPropagation(); setEditingComment(ann.id); }}
                  onMouseDown={(e) => { if (tool === 'select') handleItemMouseDown(e, ann.id); else if (tool !== 'box') e.stopPropagation(); }}
                >
                  <div
                    className={`w-full h-full rounded border-2 transition-all ${
                      isSelected || isInSelection ? 'border-solid' : 'border-dashed'
                    }`}
                    style={{ borderColor: colorDef.border, background: colorDef.fill }}
                  />

                  {/* Number badge */}
                  <div
                    className="absolute -top-2.5 -left-2.5 w-5 h-5 rounded-full flex items-center justify-center text-[9px] text-white font-medium shadow-sm"
                    style={{ background: colorDef.border }}
                  >
                    {annIdx + 1}
                  </div>

                  {/* Comment bubble */}
                  {(ann.comment || isEditing || isSelected) && (
                    <div
                      className={`absolute left-0 top-full mt-1 z-50 min-w-[160px] max-w-[260px] ${
                        isSelected ? 'opacity-100' : 'opacity-80 hover:opacity-100'
                      }`}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <div className="rounded-md border border-edge bg-card shadow-[0_4px_12px_rgba(0,0,0,0.08)] px-2.5 py-2">
                        {isEditing ? (
                          <textarea
                            autoFocus
                            defaultValue={ann.comment}
                            onBlur={(e) => updateComment(ann.id, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                updateComment(ann.id, (e.target as HTMLTextAreaElement).value);
                              }
                              if (e.key === 'Escape') setEditingComment(null);
                              e.stopPropagation();
                            }}
                            className="w-full text-[11px] bg-transparent text-ink resize-none focus:outline-none min-h-[2.5rem]"
                            placeholder="Add a comment..."
                            rows={2}
                          />
                        ) : (
                          <p
                            className={`text-[11px] leading-relaxed ${
                              ann.comment ? 'text-ink' : 'text-ink-ghost italic'
                            } cursor-text`}
                            onClick={() => setEditingComment(ann.id)}
                          >
                            {ann.comment || 'Click to add comment...'}
                          </p>
                        )}
                        {isSelected && (
                          <div className="mt-1.5 flex items-center justify-end">
                            <button
                              type="button"
                              onClick={() => removeAnnotation(ann.id)}
                              className="text-[10px] text-ink-ghost hover:text-rose-text transition-colors"
                            >
                              delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Marquee selection preview */}
            {marquee && (() => {
              const mx = Math.min(marquee.startX, marquee.curX);
              const my = Math.min(marquee.startY, marquee.curY);
              const mw = Math.abs(marquee.curX - marquee.startX);
              const mh = Math.abs(marquee.curY - marquee.startY);
              return mw > 2 && mh > 2 ? (
                <div
                  className="absolute z-50 pointer-events-none rounded border border-[var(--slate)] bg-[var(--slate)]/5"
                  style={{ left: mx, top: my, width: mw, height: mh }}
                />
              ) : null;
            })()}

            {/* Drawing preview */}
            {drawRect && drawRect.w > 2 && drawRect.h > 2 && (
              <div
                className="absolute z-50 pointer-events-none rounded border-2 border-dashed"
                style={{
                  left: drawRect.x, top: drawRect.y,
                  width: drawRect.w, height: drawRect.h,
                  borderColor: ANNOTATION_COLORS[annotationColor].border,
                  background: ANNOTATION_COLORS[annotationColor].fill,
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Sequence bar — drag to reorder annotation flow */}
      {annotations.length > 0 && (
        <div className="px-5 py-2.5 border-t border-edge bg-page shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ink-ghost uppercase tracking-wider mr-1 shrink-0">Flow</span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {annotations.map((ann, idx) => {
                const colorDef = colorForValue(ann.color);
                const isSelected = selectedAnnotation === ann.id;
                const isDragOver = seqDragging && seqDragging.overIdx === idx && seqDragging.idx !== idx;
                return (
                  <button
                    key={ann.id}
                    type="button"
                    draggable
                    onDragStart={() => handleSeqDragStart(idx)}
                    onDragOver={(e) => { e.preventDefault(); handleSeqDragOver(idx); }}
                    onDrop={(e) => { e.preventDefault(); handleSeqDrop(); }}
                    onDragEnd={() => setSeqDragging(null)}
                    onClick={() => setSelectedAnnotation(ann.id)}
                    className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-medium transition-all cursor-grab active:cursor-grabbing ${
                      isSelected
                        ? 'text-white scale-110 shadow-md'
                        : 'text-white/70 hover:scale-105 hover:text-white'
                    } ${isDragOver ? 'ring-2 ring-[var(--slate)] ring-offset-1' : ''}`}
                    style={{
                      background: isSelected ? colorDef.border : colorDef.border.replace('0.6)', '0.3)'),
                    }}
                    title={ann.comment ? `${idx + 1}: ${ann.comment}` : `Step ${idx + 1} — drag to reorder`}
                  >
                    {idx + 1}
                  </button>
                );
              })}
            </div>
            {annotations.length > 1 && (
              <span className="text-[10px] text-ink-ghost ml-2 shrink-0">drag to reorder</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
