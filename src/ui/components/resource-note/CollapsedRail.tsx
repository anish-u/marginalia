import type { FC, ReactNode } from 'react';

import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * A thin vertical rail shown in place of a collapsed pane (à la LeetCode's
 * collapsed side panels). It hints that content is still there and expands the
 * pane on click. `side` controls which chevron direction points "open".
 */
export const CollapsedRail: FC<{
  label: string;
  icon: ReactNode;
  side: 'left' | 'right';
  onExpand: () => void;
}> = ({ label, icon, side, onExpand }) => (
  <button
    type="button"
    onClick={onExpand}
    title={`Expand ${label}`}
    aria-label={`Expand ${label}`}
    className="flex h-full w-9 shrink-0 flex-col items-center gap-2 border-x bg-secondary py-3 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
  >
    {side === 'left' ? (
      <ChevronRight className="size-4" />
    ) : (
      <ChevronLeft className="size-4" />
    )}
    {icon}
    {/* Vertical label, like a docked sidebar tab. */}
    <span
      className="mt-1 text-xs font-medium tracking-wide whitespace-nowrap"
      style={{ writingMode: 'vertical-rl' }}
    >
      {label}
    </span>
  </button>
);
