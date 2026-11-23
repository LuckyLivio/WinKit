import { ArrowLeft, ArrowRight, Check, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { renderPdfPage } from "../../lib/tauriBridge";
import "./PdfPageGrid.css";

const MAX_GRID_THUMBS = 72;

export interface PdfPageGridItem {
  uid: string;
  sourcePage: number;
  widthPt: number;
  heightPt: number;
  inherentRotation: number;
  extraRotationCw: number;
}

export interface PdfPageGridLabels {
  pageTag: (origPage: number) => string;
  newOrderTag: (newIdx: number, origPage: number) => string;
  selectedDeleteBadge: string;
  selectedExtractBadge: string;
  rotateLeft: string;
  rotateRight: string;
  moveLeft: string;
  moveRight: string;
  deletePage: string;
  rotatedBadge: (deg: number) => string;
}

interface PdfPageGridProps {
  pdfPath: string;
  items: PdfPageGridItem[];
  selectedUids: Set<string>;
  highlightMode: "select" | "delete";
  draggable?: boolean;
  showBeforeAfterOrder?: boolean;
  showPageControls?: boolean;
  disabled?: boolean;
  labels: PdfPageGridLabels;
  onToggleSelect: (uid: string, shiftKey: boolean) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onRotatePage?: (uid: string, deltaCw: number) => void;
  onDeletePage?: (uid: string) => void;
}

function setThumbLru(prev: Map<string, string>, key: string, value: string): Map<string, string> {
  const next = new Map(prev);
  if (next.has(key)) next.delete(key);
  next.set(key, value);
  while (next.size > MAX_GRID_THUMBS) {
    const oldest = next.keys().next().value;
    if (oldest !== undefined) next.delete(oldest);
    else break;
  }
  return next;
}

export function PdfPageGrid({
  pdfPath,
  items,
  selectedUids,
  highlightMode,
  draggable = false,
  showBeforeAfterOrder = false,
  showPageControls = false,
  disabled = false,
  labels,
  onToggleSelect,
  onReorder,
  onRotatePage,
  onDeletePage,
}: PdfPageGridProps) {
  const [thumbs, setThumbs] = useState<Map<string, string>>(() => new Map());
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    items.slice(0, 16).forEach((it) => initial.add(`${it.sourcePage}@${it.extraRotationCw}`));
    return initial;
  });
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const pathGenRef = useRef(0);

  // Reset cache when pdfPath changes
  useEffect(() => {
    pathGenRef.current += 1;
    setThumbs(new Map());
    inFlightRef.current.clear();
  }, [pdfPath]);

  // Ensure newly rotated or reordered visible items are observed
  useEffect(() => {
    if (typeof IntersectionObserver !== "function") {
      const all = new Set<string>();
      items.slice(0, MAX_GRID_THUMBS).forEach((it) => {
        all.add(`${it.sourcePage}@${it.extraRotationCw}`);
      });
      setVisibleKeys(all);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleKeys((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const key = (entry.target as HTMLElement).dataset.thumbKey;
            if (!key) continue;
            if (entry.isIntersecting) next.add(key);
            else next.delete(key);
          }
          return next;
        });
      },
      { rootMargin: "260px 0px", threshold: 0.05 },
    );

    for (const el of cardRefs.current.values()) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);

  // Render visible thumbnails lazily with bounded LRU
  useEffect(() => {
    const gen = pathGenRef.current;
    for (const key of visibleKeys) {
      if (thumbs.has(key) || inFlightRef.current.has(key)) continue;
      const [pageRaw, rotRaw] = key.split("@");
      const pageNumber = Number.parseInt(pageRaw ?? "0", 10);
      const extraRotationCw = Number.parseInt(rotRaw ?? "0", 10);
      if (!Number.isFinite(pageNumber) || pageNumber <= 0) continue;

      inFlightRef.current.add(key);
      void renderPdfPage({
        path: pdfPath,
        pageNumber,
        targetWidthPx: 200,
        extraRotationCw,
      })
        .then((res) => {
          inFlightRef.current.delete(key);
          if (pathGenRef.current !== gen) return;
          setThumbs((prev) => setThumbLru(prev, key, res.dataUrl));
        })
        .catch(() => {
          inFlightRef.current.delete(key);
        });
    }
  }, [pdfPath, visibleKeys, thumbs]);

  return (
    <div className="pdf-page-grid" role="list" data-testid="pdf-page-grid">
      {items.map((item, idx) => {
        const isSelected = selectedUids.has(item.uid);
        const thumbKey = `${item.sourcePage}@${item.extraRotationCw}`;
        const thumbUrl = thumbs.get(thumbKey);
        const totalRot = (item.inherentRotation + item.extraRotationCw) % 360;
        const moved = showBeforeAfterOrder && idx + 1 !== item.sourcePage;

        return (
          <div
            key={item.uid}
            role="listitem"
            data-thumb-key={thumbKey}
            ref={(el) => {
              if (el) cardRefs.current.set(item.uid, el);
              else cardRefs.current.delete(item.uid);
            }}
            draggable={draggable && !disabled}
            onDragStart={() => setDragIdx(idx)}
            onDragOver={(e) => {
              if (!draggable || disabled) return;
              e.preventDefault();
              setDragOverIdx(idx);
            }}
            onDragLeave={() => {
              if (dragOverIdx === idx) setDragOverIdx(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (draggable && !disabled && dragIdx !== null && dragIdx !== idx) {
                onReorder?.(dragIdx, idx);
              }
              setDragIdx(null);
              setDragOverIdx(null);
            }}
            onDragEnd={() => {
              setDragIdx(null);
              setDragOverIdx(null);
            }}
            className={`pdf-grid-card ${isSelected ? (highlightMode === "delete" ? "is-delete-selected" : "is-selected") : ""} ${dragIdx === idx ? "is-dragging" : ""} ${dragOverIdx === idx && dragIdx !== idx ? "is-drag-over" : ""}`}
          >
            <button
              type="button"
              className="pdf-grid-thumb-btn"
              disabled={disabled}
              aria-pressed={isSelected}
              onClick={(e) => onToggleSelect(item.uid, e.shiftKey)}
            >
              <div className="pdf-grid-thumb-box">
                {thumbUrl ? (
                  <img
                    src={thumbUrl}
                    alt={`Page ${item.sourcePage}`}
                    className="pdf-grid-thumb-img"
                    draggable={false}
                  />
                ) : (
                  <span className="pdf-grid-thumb-placeholder mono">{item.sourcePage}</span>
                )}

                {isSelected && (
                  <span
                    className={`pdf-grid-state-pill ${highlightMode === "delete" ? "is-delete" : "is-select"}`}
                  >
                    {highlightMode === "delete" ? (
                      <>
                        <Trash2 size={11} strokeWidth={2} aria-hidden="true" />
                        <span>{labels.selectedDeleteBadge}</span>
                      </>
                    ) : (
                      <>
                        <Check size={11} strokeWidth={2.2} aria-hidden="true" />
                        <span>{labels.selectedExtractBadge}</span>
                      </>
                    )}
                  </span>
                )}

                {item.extraRotationCw !== 0 && (
                  <span className="pdf-grid-rot-pill mono">{labels.rotatedBadge(totalRot)}</span>
                )}
              </div>

              <div className="pdf-grid-caption">
                <span className={`pdf-grid-page-label mono ${moved ? "is-moved" : ""}`}>
                  {showBeforeAfterOrder
                    ? labels.newOrderTag(idx + 1, item.sourcePage)
                    : labels.pageTag(item.sourcePage)}
                </span>
              </div>
            </button>

            {showPageControls && (
              <div className="pdf-grid-controls">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  title={labels.moveLeft}
                  aria-label={labels.moveLeft}
                  disabled={disabled || idx === 0}
                  onClick={() => onReorder?.(idx, idx - 1)}
                >
                  <ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  title={labels.rotateLeft}
                  aria-label={labels.rotateLeft}
                  disabled={disabled}
                  onClick={() => onRotatePage?.(item.uid, 270)}
                >
                  <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  title={labels.rotateRight}
                  aria-label={labels.rotateRight}
                  disabled={disabled}
                  onClick={() => onRotatePage?.(item.uid, 90)}
                >
                  <RotateCw size={13} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  title={labels.moveRight}
                  aria-label={labels.moveRight}
                  disabled={disabled || idx === items.length - 1}
                  onClick={() => onReorder?.(idx, idx + 1)}
                >
                  <ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  title={labels.deletePage}
                  aria-label={labels.deletePage}
                  disabled={disabled || items.length <= 1}
                  onClick={() => onDeletePage?.(item.uid)}
                >
                  <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
