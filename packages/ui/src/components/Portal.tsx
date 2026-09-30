import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode, ReactPortal } from 'react';

export interface PortalProps {
  children: ReactNode;
  /** Overlay layers share one host node so their DOM order matches mount order. */
  containerId?: string;
}

export function Portal({ children, containerId = 'ritmo-portal-root' }: PortalProps): ReactPortal | null {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const existing = document.getElementById(containerId);
    if (existing) {
      setHost(existing);
      return;
    }
    const node = document.createElement('div');
    node.id = containerId;
    document.body.appendChild(node);
    setHost(node);
    return () => {
      // Another overlay may still be mounted into the same host.
      if (node.childElementCount === 0) node.remove();
    };
  }, [containerId]);

  if (!host) return null;
  return createPortal(children, host);
}

let lockCount = 0;
let restoreOverflow: string | null = null;

/**
 * Reference-counted `overflow: hidden` on <body>. Nested overlays each take a
 * lock, and only the last one to unmount restores the original value.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (lockCount === 0) {
      restoreOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    lockCount += 1;
    return () => {
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount === 0) {
        document.body.style.overflow = restoreOverflow ?? '';
        restoreOverflow = null;
      }
    };
  }, [active]);
}
