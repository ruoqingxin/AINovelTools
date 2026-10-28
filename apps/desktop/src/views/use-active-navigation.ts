import { useEffect, useRef } from "react";

export function useActiveNavigation(activeKey: string) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    function reveal() {
      const nav = ref.current;
      const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!nav || !active) return;
      const bounds = nav.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      if (item.left < bounds.left) nav.scrollLeft += item.left - bounds.left;
      else if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
    }
    reveal();
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [activeKey]);
  return ref;
}
