/**
 * The window frame: the sidebar stays put at full height, and the content area to its right takes the
 * remaining height and scrolls itself when a page is taller. The window itself never scrolls.
 * Full-height pages (Kanban, Preview, Deploy, ...) use h-full and fill the content area exactly.
 */
import type { ReactNode } from 'react';

interface AppShellProps {
  sidebar: ReactNode;
  /** Above the content area, e.g. the project tabs */
  header?: ReactNode;
  /** The current page */
  content: ReactNode;
  /** Dialogs, panels and notifications that belong to the window rather than to a page */
  children?: ReactNode;
}

export function AppShell({ sidebar, header, content, children }: AppShellProps) {
  return (
    <div data-testid="app-shell" className="flex h-screen overflow-hidden bg-background">
      {sidebar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {header}
        <main className="min-h-0 flex-1 overflow-y-auto">{content}</main>
      </div>
      {children}
    </div>
  );
}
