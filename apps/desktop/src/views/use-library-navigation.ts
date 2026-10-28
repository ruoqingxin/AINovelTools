import { useEffect, useRef, useState } from "react";
import { useWideWorkspace } from "./workspace-panel";

export function useLibraryNavigation(initialDetail = false) {
  const wide = useWideWorkspace(851);
  const [detailOpen, setDetailOpen] = useState(initialDetail);
  const list = useRef<HTMLElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  useEffect(() => {
    if (!wide && detailOpen) detail.current?.focus({ preventScroll: true });
  }, [wide, detailOpen]);

  function openDetail() {
    if (!detailOpen) listScroll.current = list.current?.scrollTop ?? 0;
    setDetailOpen(true);
  }
  function closeDetail() {
    setDetailOpen(false);
    window.requestAnimationFrame(() => {
      if (!list.current) return;
      list.current.scrollTop = listScroll.current;
      list.current.querySelector<HTMLButtonElement>('[data-selected="true"]')?.focus({ preventScroll: true });
    });
  }
  return { wide, detailOpen, list, detail, openDetail, closeDetail };
}
